//! Process sandbox capabilities exported via N-API.
//!
//! Wraps `nono::CapabilitySet` and `nono_proxy` for OS-enforced sandboxing
//! of spawned shell commands.

use std::{path::Path, sync::Arc};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use nono::{AccessMode, CapabilitySet, Sandbox};

/// Filesystem access mode for sandbox capabilities.
#[napi]
pub enum SandboxAccessMode {
	/// Read-only access.
	Read,
	/// Write-only access.
	Write,
	/// Read and write access.
	ReadWrite,
}

impl From<SandboxAccessMode> for AccessMode {
	fn from(mode: SandboxAccessMode) -> Self {
		match mode {
			SandboxAccessMode::Read => Self::Read,
			SandboxAccessMode::Write => Self::Write,
			SandboxAccessMode::ReadWrite => Self::ReadWrite,
		}
	}
}

/// Capability set for sandboxing spawned processes.
///
/// Build a capability set describing allowed filesystem paths and network
/// access, then pass it to the Shell to enforce via `pre_exec`.
#[napi]
pub struct SandboxCaps {
	pub(crate) inner: Arc<CapabilitySet>,
}

impl Clone for SandboxCaps {
	fn clone(&self) -> Self {
		Self { inner: self.inner.clone() }
	}
}

#[napi]
impl SandboxCaps {
	/// Create a new empty capability set (denies everything by default).
	#[napi(constructor)]
	pub fn new() -> Self {
		Self { inner: Arc::new(CapabilitySet::new()) }
	}

	/// Add a directory path with the specified access mode.
	///
	/// Returns a new `SandboxCaps` with the path added.
	#[napi]
	pub fn allow_path(&self, path: String, mode: SandboxAccessMode) -> Result<SandboxCaps> {
		let caps = (*self.inner)
			.clone()
			.allow_path(&path, AccessMode::from(mode))
			.map_err(|e| Error::from_reason(format!("Failed to add path capability: {e}")))?;
		Ok(Self { inner: Arc::new(caps) })
	}

	/// Block all network access.
	#[napi]
	pub fn block_network(&self) -> SandboxCaps {
		let caps = (*self.inner).clone().block_network();
		Self { inner: Arc::new(caps) }
	}

	/// Restrict network to only the specified proxy port on localhost.
	#[napi]
	pub fn proxy_only(&self, port: u16) -> SandboxCaps {
		let caps = (*self.inner).clone().proxy_only(port);
		Self { inner: Arc::new(caps) }
	}

	/// Query whether a path with the given access mode would be allowed.
	///
	/// This is an advisory check — it does not apply the sandbox, just
	/// evaluates the capability set.
	#[napi]
	pub fn query_path(&self, path: String, mode: SandboxAccessMode) -> bool {
		self
			.inner
			.path_covered_with_access(Path::new(&path), AccessMode::from(mode))
	}

	/// Get a human-readable summary of the capabilities.
	#[napi]
	pub fn summary(&self) -> String {
		self.inner.summary()
	}
}

/// Options for starting the sandbox proxy.
#[napi(object)]
pub struct SandboxProxyOptions {
	/// Port to bind on (0 for OS-assigned ephemeral port).
	pub bind_port: Option<u16>,
}

/// Result of starting the sandbox proxy.
#[napi(object)]
pub struct SandboxProxyStartResult {
	/// The port the proxy is listening on.
	pub port:     u16,
	/// Environment variables to inject into child processes.
	pub env_vars: Vec<SandboxProxyEnvVar>,
}

/// A single environment variable key-value pair.
#[napi(object)]
pub struct SandboxProxyEnvVar {
	/// Environment variable name.
	pub key:   String,
	/// Environment variable value.
	pub value: String,
}

/// Network filtering proxy that runs in the main process.
///
/// Provides domain-level HTTPS filtering via CONNECT tunnel.
/// Child processes get `HTTPS_PROXY` pointed at this proxy and kernel-level
/// network restriction to only reach the proxy port.
#[napi]
pub struct SandboxProxy {
	handle: Option<nono_proxy::ProxyHandle>,
}

#[napi]
impl SandboxProxy {
	/// Create a new proxy instance (not yet started).
	#[napi(constructor)]
	pub fn new() -> Self {
		Self { handle: None }
	}

	/// Start the proxy with the given allowed hosts.
	///
	/// Hosts can be exact (`"api.openai.com"`) or wildcard (`"*.github.com"`).
	/// Returns the assigned port and environment variables to inject.
	#[napi]
	pub fn start(
		&mut self,
		allowed_hosts: Vec<String>,
		options: Option<SandboxProxyOptions>,
	) -> Result<SandboxProxyStartResult> {
		if self.handle.is_some() {
			return Err(Error::from_reason("Proxy is already running"));
		}

		let bind_port = options.and_then(|o| o.bind_port).unwrap_or(0);

		let config = nono_proxy::ProxyConfig { allowed_hosts, bind_port, ..Default::default() };

		let handle = tokio::runtime::Handle::current()
			.block_on(nono_proxy::start(config))
			.map_err(|e| Error::from_reason(format!("Failed to start proxy: {e}")))?;

		let port = handle.port;
		let env_vars: Vec<SandboxProxyEnvVar> = handle
			.env_vars()
			.into_iter()
			.map(|(key, value)| SandboxProxyEnvVar { key, value })
			.collect();

		self.handle = Some(handle);

		Ok(SandboxProxyStartResult { port, env_vars })
	}

	/// Shut down the proxy gracefully.
	#[napi]
	pub fn shutdown(&mut self) {
		if let Some(handle) = self.handle.take() {
			handle.shutdown();
		}
	}
}

impl Drop for SandboxProxy {
	fn drop(&mut self) {
		if let Some(handle) = self.handle.take() {
			handle.shutdown();
		}
	}
}

/// Check if OS-level sandboxing is supported on this platform.
#[napi]
pub fn sandbox_is_supported() -> bool {
	Sandbox::is_supported()
}
