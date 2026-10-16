fn main() -> std::io::Result<()> {
    let url = std::env::args()
        .nth(1)
        .or_else(|| std::env::var("SCREEN_SHARE_URL").ok())
        .unwrap_or_else(|| {
            option_env!("SCREEN_SHARE_URL")
                .unwrap_or("http://localhost:8787")
                .into()
        });
    if !url.starts_with("https://") && !url.starts_with("http://localhost:") {
        return Err(std::io::Error::other(
            "Use an HTTPS presenter URL (or localhost for development).",
        ));
    }
    #[cfg(windows)]
    for root in ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok())
    {
        for relative in [
            "Microsoft/Edge/Application/msedge.exe",
            "Google/Chrome/Application/chrome.exe",
        ] {
            let browser = std::path::PathBuf::from(&root).join(relative);
            if browser.exists() {
                std::process::Command::new(browser)
                    .arg(format!("--app={url}"))
                    .spawn()?;
                return Ok(());
            }
        }
    }
    #[cfg(windows)]
    return Err(std::io::Error::other(format!(
        "Install Edge or Chrome, or open {url} manually."
    )));
    #[cfg(not(windows))]
    {
        println!("Open {url} in Edge or Chrome.");
        Ok(())
    }
}
