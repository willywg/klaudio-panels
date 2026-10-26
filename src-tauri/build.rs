fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        tauri_build::build();
        return;
    }

    // Tauri links its resource file only into application binaries, not lib tests.
    // Keep its icons/version resources, but embed one shared manifest in every
    // executable so native dialogs can resolve TaskDialogIndirect in comctl32 v6.
    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("Tauri build configuration failed");

    println!("cargo:rerun-if-changed=windows-app-manifest.xml");
    let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("windows-app-manifest.xml");
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    } else {
        let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
        let rc = out.join("application-manifest.rc");
        let object = out.join("application-manifest.o");
        std::fs::write(
            &rc,
            format!(
                "1 24 \"{}\"\n",
                manifest.display().to_string().replace('\\', "/")
            ),
        )
        .expect("could not write the Windows manifest resource");
        let status = std::process::Command::new("windres")
            .args([
                "--codepage=65001",
                "--input-format=rc",
                "--output-format=coff",
            ])
            .arg("--input")
            .arg(&rc)
            .arg("--output")
            .arg(&object)
            .status()
            .expect("could not run windres to compile the Windows manifest");
        assert!(
            status.success(),
            "Windows manifest resource compilation failed"
        );
        println!("cargo:rustc-link-arg={}", object.display());
    }
}
