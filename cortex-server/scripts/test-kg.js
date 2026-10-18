#!/usr/bin/env node

// KG-2 — Test Script
// Command-line script to run KG-2 tests
// Usage: node scripts/test-kg.js [options]
// Options:
//   --help, -h        Show help
//   --all, -a        Run all tests including volume tests
//   --basic, -b      Run basic tests only
//   --file, -f       Run file-based database tests
//   --volume small|medium|large  Run specific volume test
//   --quiet, -q      Minimal output
//   --verbose, -v    Verbose output

import { runAllTests, runTestsAndExit, runFileBasedTests } from '../src/lib/kg-test.js';

function showHelp() {
  console.log(`
KG-2 Knowledge Graph Test Runner

Usage: node scripts/test-kg.js [options]

Options:
  --help, -h        Show this help message
  --all, -a        Run all tests including volume tests
  --basic, -b      Run basic tests only (schema, migrations, normalization)
  --file, -f       Run file-based database tests
  --volume V       Run specific volume test (small, medium, large)
  --quiet, -q      Minimal output
  --verbose, -v    Verbose output

Examples:
  node scripts/test-kg.js                    # Run all tests
  node scripts/test-kg.js --basic          # Run basic tests only
  node scripts/test-kg.js --file           # Run file-based tests
  node scripts/test-kg.js --volume medium  # Run medium volume test
  node scripts/test-kg.js --quiet          # Minimal output
`);
}

function parseArgs(args) {
  const options = {
    help: false,
    all: false,
    basic: false,
    file: false,
    volume: null,
    quiet: false,
    verbose: false,
    _: []
  };

  let i = 2; // Skip node and script path
  while (i < args.length) {
    const arg = args[i];
    
    switch (arg) {
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--all':
      case '-a':
        options.all = true;
        break;
      case '--basic':
      case '-b':
        options.basic = true;
        break;
      case '--file':
      case '-f':
        options.file = true;
        break;
      case '--quiet':
      case '-q':
        options.quiet = true;
        break;
      case '--verbose':
      case '-v':
        options.verbose = true;
        break;
      case '--volume':
        if (i + 1 < args.length) {
          const volume = args[++i];
          if (['small', 'medium', 'large'].includes(volume)) {
            options.volume = volume;
          } else {
            console.error(`Invalid volume: ${volume}. Must be small, medium, or large.`);
            process.exit(1);
          }
        } else {
          console.error('--volume requires a value (small, medium, or large)');
          process.exit(1);
        }
        break;
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
        options._.push(arg);
        break;
    }
    i++;
  }

  return options;
}

async function runBasicTests() {
  console.log('Running basic tests...\n');
  
  // Import individual test functions
  const { 
    runSchemaTests, 
    runMigrationTests, 
    runNormalizationTests,
    TestReporter 
  } = await import('../src/lib/kg-test.js');

  const reporter = new TestReporter();
  
  try {
    await runSchemaTests(reporter);
    await runMigrationTests(reporter);
    await runNormalizationTests(reporter);
    
    const summary = reporter.summary();
    return summary;
  } catch (error) {
    reporter.fail('Basic tests', error);
    const summary = reporter.summary();
    return summary;
  }
}

async function runSpecificVolumeTest(volume) {
  console.log(`Running ${volume} volume test...\n`);
  
  const { runStoreTests, TestReporter } = await import('../src/lib/kg-test.js');
  const reporter = new TestReporter();
  
  try {
    await runStoreTests(reporter, volume);
    const summary = reporter.summary();
    return summary;
  } catch (error) {
    reporter.fail(`Volume test (${volume})`, error);
    const summary = reporter.summary();
    return summary;
  }
}

// Main function
async function main() {
  const args = process.argv;
  const options = parseArgs(args);

  if (options.help) {
    showHelp();
    process.exit(0);
  }

  try {
    if (options.file) {
      const summary = await runFileBasedTests();
      process.exit(summary.success ? 0 : 1);
    } else if (options.volume) {
      const summary = await runSpecificVolumeTest(options.volume);
      process.exit(summary.success ? 0 : 1);
    } else if (options.basic) {
      const summary = await runBasicTests();
      process.exit(summary.success ? 0 : 1);
    } else {
      // Default: run all tests
      if (options.verbose) {
        console.log('Running all KG-2 tests...\n');
      }
      
      const summary = await runAllTests();
      
      if (options.quiet) {
        console.log(`\nSummary: ${summary.passed} passed, ${summary.failed} failed`);
      }
      
      process.exit(summary.success ? 0 : 1);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Run main
main();
