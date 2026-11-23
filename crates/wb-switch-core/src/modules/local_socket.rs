//! Optional private HTTP transport for hosts that prohibit loopback TCP.
use axum::Router;
use hyper_util::{
    rt::{TokioExecutor, TokioIo},
    server::conn::auto::Builder,
    service::TowerToHyperService,
};
use std::{future::Future, io, os::unix::fs::PermissionsExt, path::PathBuf};
use tokio::net::{UnixListener, UnixStream};

pub fn path(name: &str) -> Option<PathBuf> {
    std::env::var_os("WB_SWITCH_SOCKET_DIR")
        .map(|dir| PathBuf::from(dir).join(format!("{name}.sock")))
}

pub async fn bind(path: &std::path::Path) -> io::Result<UnixListener> {
    if path.exists() {
        if UnixStream::connect(path).await.is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::AddrInUse,
                "Socket already has a running service",
            ));
        }
        let meta = std::fs::symlink_metadata(path)?;
        use std::os::unix::fs::FileTypeExt;
        if !meta.file_type().is_socket() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "Socket path is an existing file",
            ));
        }
        std::fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

pub async fn serve(
    listener: UnixListener,
    app: Router,
    shutdown: impl Future<Output = ()>,
) -> io::Result<()> {
    tokio::pin!(shutdown);
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            Some(_) = connections.join_next(), if !connections.is_empty() => {},
            incoming = listener.accept() => {
                let (stream, _) = incoming?;
                let service = TowerToHyperService::new(app.clone());
                connections.spawn(async move {
                    let _ = Builder::new(TokioExecutor::new()).serve_connection(TokioIo::new(stream), service).await;
                });
            }
        }
    }
    while connections.join_next().await.is_some() {}
    Ok(())
}
