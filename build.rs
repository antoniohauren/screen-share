fn main() {
    println!("cargo:rerun-if-env-changed=SCREEN_SHARE_URL");
    println!("cargo:rerun-if-changed=assets/launcher.rc");
    println!("cargo:rerun-if-changed=web/icon.ico");
    #[cfg(windows)]
    embed_resource::compile_for(
        "assets/launcher.rc",
        ["screen-share-launcher"],
        embed_resource::NONE,
    )
    .manifest_required()
    .expect("Failed to embed the Windows app icon");
}
