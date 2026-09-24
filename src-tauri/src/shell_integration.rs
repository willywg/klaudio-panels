//! Keeps the `pbcopy` shim first on `PATH` in shell tabs (#117).
//!
//! `spawn_pty` puts the shim dir first on every child's `PATH`. Agent tabs
//! exec the agent directly, so that holds. A shell tab runs `$SHELL -l -i`,
//! and on macOS a login zsh reads `/etc/zprofile`, whose `path_helper`
//! rebuilds `PATH` with the system dirs in front: `/usr/bin/pbcopy` wins and
//! the copy never reaches the clipboard history.
//!
//! The fix re-asserts the shim dir *after* the user's startup files without
//! touching them, the way VS Code's shell integration does. A zsh shell tab
//! starts with `ZDOTDIR` pointing at a Klaudio-owned dir. Each file there
//! sources the user's real one, at top level (inside a function, a bare
//! `typeset` in the user's file would become a local), with `ZDOTDIR` set
//! back to the user's value while it runs. The `.zshrc` wrapper then moves
//! the shim dir to the front and restores the user's `ZDOTDIR`, so zsh reads
//! the user's own `.zlogin` and anything the shell spawns sees their
//! `ZDOTDIR`, not ours.
//!
//! Only zsh is wrapped. bash ignores `--rcfile` in a login shell, and
//! emulating a login shell around it would change more than it fixes; bash
//! and fish shell tabs keep today's behavior.

use std::path::{Path, PathBuf};

/// Holds the user's `ZDOTDIR` while ours is in effect. Unset when they had
/// none, which is different from `$HOME` for anything that checks.
const USER_ZDOTDIR: &str = "KLAUDIO_USER_ZDOTDIR";
/// The shim dir, handed to `.zshrc` so it can move it to the front.
const SHIM_DIR: &str = "KLAUDIO_SHIM_DIR";

/// Where the zsh wrapper files live, next to the shim dir.
pub fn zsh_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|c| c.join("klaudio-panels/zsh"))
}

const HEADER: &str = "# Klaudio Panels: zsh startup wrapper for shell tabs (#117).\n\
# Sources your own file, then keeps Klaudio's pbcopy shim first on PATH.\n\
# Generated at app boot; edits here are overwritten.\n";

/// Source the user's `name` with their `ZDOTDIR` in effect, then record the
/// `ZDOTDIR` they ended with (a `.zshenv` may set it) and put ours back.
fn source_user_file(name: &str) -> String {
    format!(
        r#"_klaudio_zdotdir=$ZDOTDIR
if [[ -n ${{{USER_ZDOTDIR}+x}} ]]; then ZDOTDIR=${USER_ZDOTDIR}; else unset ZDOTDIR; fi
[[ -f ${{ZDOTDIR:-$HOME}}/{name} ]] && source ${{ZDOTDIR:-$HOME}}/{name}
if [[ -n ${{ZDOTDIR+x}} ]]; then {USER_ZDOTDIR}=$ZDOTDIR; else unset {USER_ZDOTDIR}; fi
ZDOTDIR=$_klaudio_zdotdir
unset _klaudio_zdotdir
"#
    )
}

fn zshrc() -> String {
    format!(
        r#"{HEADER}{source}if [[ -n ${SHIM_DIR} ]]; then
  path=("${SHIM_DIR}" ${{path:#${{(b){SHIM_DIR}}}}})
fi
if [[ -n ${{{USER_ZDOTDIR}+x}} ]]; then export ZDOTDIR=${USER_ZDOTDIR}; else unset ZDOTDIR; fi
unset {USER_ZDOTDIR} {SHIM_DIR}
"#,
        source = source_user_file(".zshrc"),
    )
}

fn wrapper_files() -> [(&'static str, String); 3] {
    [
        (".zshenv", format!("{HEADER}{}", source_user_file(".zshenv"))),
        (".zprofile", format!("{HEADER}{}", source_user_file(".zprofile"))),
        (".zshrc", zshrc()),
    ]
}

fn write_wrapper_into(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    for (name, body) in wrapper_files() {
        std::fs::write(dir.join(name), body)?;
    }
    Ok(())
}

/// Write the wrapper files. Called once at boot, next to the shim.
pub fn install() -> std::io::Result<()> {
    match zsh_dir() {
        Some(dir) => write_wrapper_into(&dir),
        None => Ok(()),
    }
}

fn is_zsh(shell: &str) -> bool {
    Path::new(shell).file_name().and_then(|n| n.to_str()) == Some("zsh")
}

fn apply_zsh_env(
    env: Vec<(String, String)>,
    zsh_dir: &Path,
    shim_dir: &Path,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::with_capacity(env.len() + 3);
    for (k, v) in env {
        match k.as_str() {
            "ZDOTDIR" => out.push((USER_ZDOTDIR.into(), v)),
            USER_ZDOTDIR | SHIM_DIR => {}
            _ => out.push((k, v)),
        }
    }
    out.push(("ZDOTDIR".into(), zsh_dir.display().to_string()));
    out.push((SHIM_DIR.into(), shim_dir.display().to_string()));
    out
}

/// The env for a shell tab running `shell`. Unchanged unless it is zsh, the
/// shim is live, and the wrapper files are in place: a missing wrapper must
/// never leave the user's shell reading an empty `ZDOTDIR`.
pub fn shell_tab_env(shell: &str, env: Vec<(String, String)>) -> Vec<(String, String)> {
    if !is_zsh(shell) || !crate::clipboard_history::shim_active() {
        return env;
    }
    let (Some(zsh_dir), Some(shim_dir)) = (zsh_dir(), crate::clipboard_history::shim_dir()) else {
        return env;
    };
    if !zsh_dir.join(".zshrc").is_file() {
        return env;
    }
    apply_zsh_env(env, &zsh_dir, &shim_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir(tag: &str) -> TempDir {
        let dir = std::env::temp_dir().join(format!(
            "klaudio-zsh-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    /// A fake home, a fake shim dir holding a `pbcopy`, and the wrapper, all
    /// in one temp dir whose name has a space in it.
    struct Fixture {
        root: TempDir,
        home: PathBuf,
        shim: PathBuf,
        wrapper: PathBuf,
    }

    fn fixture(tag: &str) -> Fixture {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_dir(tag);
        let base = root.0.join("with space");
        let home = base.join("home");
        let shim = base.join("shim bin");
        let wrapper = base.join("zsh");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&shim).unwrap();
        let pbcopy = shim.join("pbcopy");
        std::fs::write(&pbcopy, "#!/bin/sh\nexec /usr/bin/pbcopy \"$@\"\n").unwrap();
        std::fs::set_permissions(&pbcopy, std::fs::Permissions::from_mode(0o755)).unwrap();
        write_wrapper_into(&wrapper).unwrap();
        Fixture {
            root,
            home,
            shim,
            wrapper,
        }
    }

    /// Start a login, interactive zsh the way a shell tab does, through the
    /// env `apply_zsh_env` builds, and print what the script asks for.
    fn run_zsh(fx: &Fixture, extra_env: &[(&str, &str)], script: &str) -> Option<String> {
        if !Path::new("/bin/zsh").is_file() {
            return None;
        }
        let mut env: Vec<(String, String)> = vec![
            ("HOME".into(), fx.home.display().to_string()),
            (
                "PATH".into(),
                format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", fx.shim.display()),
            ),
            ("TERM".into(), "dumb".into()),
        ];
        env.extend(extra_env.iter().map(|(k, v)| (k.to_string(), v.to_string())));
        let env = apply_zsh_env(env, &fx.wrapper, &fx.shim);
        let out = Command::new("/bin/zsh")
            .args(["-l", "-i", "-c", script])
            .env_clear()
            .envs(env)
            .current_dir(&fx.root.0)
            .output()
            .unwrap();
        Some(String::from_utf8_lossy(&out.stdout).to_string())
    }

    #[test]
    fn a_login_zsh_finds_the_shim_and_still_reads_the_users_files() {
        let fx = fixture("plain");
        // The user's files push /usr/bin to the front as well, the way
        // path_helper does, and leave marks we can check for.
        std::fs::write(fx.home.join(".zshenv"), "export FROM_ZSHENV=1\n").unwrap();
        std::fs::write(
            fx.home.join(".zprofile"),
            "export PATH=/usr/bin:$PATH\nexport FROM_ZPROFILE=1\n",
        )
        .unwrap();
        std::fs::write(
            fx.home.join(".zshrc"),
            "export PATH=/usr/bin:$PATH\ntypeset FROM_ZSHRC=1\nalias kl=true\n",
        )
        .unwrap();
        std::fs::write(fx.home.join(".zlogin"), "FROM_ZLOGIN=1\n").unwrap();

        let Some(out) = run_zsh(
            &fx,
            &[],
            "print -r -- \"pbcopy=$(command -v pbcopy)\"; \
             print -r -- \"marks=$FROM_ZSHENV$FROM_ZPROFILE$FROM_ZSHRC$FROM_ZLOGIN\"; \
             print -r -- \"alias=$(alias kl)\"; \
             print -r -- \"zdotdir=${ZDOTDIR-unset}\"; \
             print -r -- \"leak=${KLAUDIO_USER_ZDOTDIR-}${KLAUDIO_SHIM_DIR-}\"; \
             for p in $path; do print -r -- \"path=$p\"; done",
        ) else {
            return;
        };
        let shim = fx.shim.join("pbcopy").display().to_string();
        assert!(out.contains(&format!("pbcopy={shim}\n")), "{out}");
        assert!(out.contains("marks=1111\n"), "{out}");
        assert!(out.contains("alias=kl=true\n"), "{out}");
        assert!(out.contains("zdotdir=unset\n"), "{out}");
        assert!(out.contains("leak=\n"), "{out}");
        let shim_entry = format!("path={}", fx.shim.display());
        assert_eq!(out.lines().filter(|l| *l == shim_entry).count(), 1, "{out}");
    }

    #[test]
    fn a_users_own_zdotdir_is_honored_and_restored() {
        let fx = fixture("zdotdir");
        let config = fx.home.join("config zsh");
        std::fs::create_dir_all(&config).unwrap();
        // Set from the environment (the hydrated env carries it)...
        std::fs::write(config.join(".zshrc"), "FROM_CONFIG_ZSHRC=1\n").unwrap();
        let Some(out) = run_zsh(
            &fx,
            &[("ZDOTDIR", &config.display().to_string())],
            "print -r -- \"rc=$FROM_CONFIG_ZSHRC zdotdir=$ZDOTDIR pbcopy=$(command -v pbcopy)\"",
        ) else {
            return;
        };
        let shim = fx.shim.join("pbcopy").display().to_string();
        assert!(
            out.contains(&format!(
                "rc=1 zdotdir={} pbcopy={shim}\n",
                config.display()
            )),
            "{out}"
        );

        // ...and set by the user's ~/.zshenv, the other common spelling.
        let moved = fx.home.join("moved");
        std::fs::create_dir_all(&moved).unwrap();
        std::fs::write(moved.join(".zshrc"), "FROM_MOVED_ZSHRC=1\n").unwrap();
        std::fs::write(
            fx.home.join(".zshenv"),
            format!("ZDOTDIR='{}'\n", moved.display()),
        )
        .unwrap();
        let Some(out) = run_zsh(
            &fx,
            &[],
            "print -r -- \"rc=$FROM_MOVED_ZSHRC zdotdir=$ZDOTDIR\"",
        ) else {
            return;
        };
        assert!(
            out.contains(&format!("rc=1 zdotdir={}\n", moved.display())),
            "{out}"
        );
    }

    #[test]
    fn only_zsh_is_wrapped() {
        assert!(is_zsh("/bin/zsh"));
        assert!(is_zsh("/opt/homebrew/bin/zsh"));
        assert!(!is_zsh("/bin/bash"));
        assert!(!is_zsh("/opt/homebrew/bin/fish"));
        assert!(!is_zsh("/bin/sh"));
        let env = vec![("ZDOTDIR".to_string(), "/x".to_string())];
        assert_eq!(shell_tab_env("/bin/bash", env.clone()), env);
    }
}
