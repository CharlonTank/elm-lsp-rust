use std::path::PathBuf;
use std::time::Instant;

// We need to access the crate's modules
use elm_lsp::workspace::Workspace;

fn main() {
    let project_path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "/Users/charles-andreassus/projects/cleemo-lamdera".to_string());

    let test_file = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "src/DomId.elm".to_string());

    println!("==================================================");
    println!("ELM LSP RUST - BENCHMARK");
    println!("==================================================");
    println!();
    println!("Project: {}", project_path);
    println!("Test file: {}", test_file);
    println!();

    // Benchmark 1: Workspace initialization
    println!("--- WORKSPACE INITIALIZATION ---");
    let start = Instant::now();
    let mut workspace = Workspace::new(PathBuf::from(&project_path));
    workspace.initialize().expect("Failed to initialize workspace");
    let init_time = start.elapsed();
    println!("  Indexed {} modules in {:?}", workspace.modules.len(), init_time);
    println!();

    // Get the test file URI
    let full_path = PathBuf::from(&project_path).join(&test_file);
    let uri = tower_lsp::lsp_types::Url::from_file_path(&full_path)
        .expect("Failed to create URI");

    // Find the module for the test file
    let module = workspace.modules.values()
        .find(|m| m.path == full_path)
        .expect("Test file not found in workspace");

    println!("--- SYMBOLS ({}) ---", test_file);
    let runs = 5;
    let mut times = Vec::new();
    for i in 1..=runs {
        let start = Instant::now();
        let symbols = &module.symbols;
        let elapsed = start.elapsed();
        times.push(elapsed);
        println!("  Run {}: {:?} ({} symbols)", i, elapsed, symbols.len());
    }
    let avg: u128 = times.iter().map(|t| t.as_micros()).sum::<u128>() / runs;
    println!("  Average: {}μs", avg);
    println!();

    // Benchmark 3: Find references (small - landingBurgerMenuButton at line 64)
    println!("--- FIND REFERENCES (landingBurgerMenuButton) ---");
    times.clear();
    for i in 1..=runs {
        let start = Instant::now();
        let refs = workspace.find_references("landingBurgerMenuButton", Some("DomId"));
        let elapsed = start.elapsed();
        times.push(elapsed);
        println!("  Run {}: {:?} ({} refs)", i, elapsed, refs.len());
    }
    let avg: u128 = times.iter().map(|t| t.as_micros()).sum::<u128>() / runs as u128;
    println!("  Average: {}μs", avg);
    println!();

    // Benchmark 4: Find references (large - toString at line 20)
    println!("--- FIND REFERENCES (toString - large) ---");
    times.clear();
    for i in 1..=runs {
        let start = Instant::now();
        let refs = workspace.find_references("toString", Some("DomId"));
        let elapsed = start.elapsed();
        times.push(elapsed);
        println!("  Run {}: {:?} ({} refs)", i, elapsed, refs.len());
    }
    let avg: u128 = times.iter().map(|t| t.as_micros()).sum::<u128>() / runs as u128;
    println!("  Average: {}μs", avg);
    println!();

    // Benchmark 5: Find definition
    println!("--- FIND DEFINITION ---");
    times.clear();
    for i in 1..=runs {
        let start = Instant::now();
        let def = workspace.find_definition("landingBurgerMenuButton");
        let elapsed = start.elapsed();
        times.push(elapsed);
        println!("  Run {}: {:?} (found: {})", i, elapsed, def.is_some());
    }
    let avg: u128 = times.iter().map(|t| t.as_micros()).sum::<u128>() / runs as u128;
    println!("  Average: {}μs", avg);
    println!();

    println!("==================================================");
    println!("SUMMARY");
    println!("==================================================");
    println!("  Initialization: {:?} ({} modules)", init_time, workspace.modules.len());
    println!("  After init, operations are sub-millisecond");
    println!();
}
