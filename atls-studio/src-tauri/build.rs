use std::path::Path;
use std::process;

fn main() {
    // `tauri::generate_context!()` embeds ../dist at compile time. Plain `cargo build`
    // in src-tauri does not run `beforeBuildCommand`; build the frontend first.
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
    let index = Path::new(&manifest_dir).join("../dist/index.html");
    if !index.is_file() {
        eprintln!(
            "\nerror: Tauri frontend bundle missing: {}\n\
             \n\
             Build the Vite app first from the atls-studio directory:\n\
               npm run build\n\
             \n\
             Or use the full Tauri entry points (they run the frontend build):\n\
               npm run tauri build\n\
               npm run tauri dev\n",
            index.display()
        );
        process::exit(1);
    }
    tauri_build::build()
}
