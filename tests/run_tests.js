const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TESTS_DIR = __dirname;
const PROJECT_ROOT = path.join(__dirname, '..');
const IMAGE_DIR = path.join(PROJECT_ROOT, 'timetable_images');
const TEST_IMAGES_DIR = path.join(TESTS_DIR, 'test_timetable_images');
const TESTS_FILE = path.join(TESTS_DIR, 'tests.json');

// Load test configuration
const testsConfig = JSON.parse(fs.readFileSync(TESTS_FILE, 'utf8'));

function clearImageDirectory() {
  if (fs.existsSync(IMAGE_DIR)) {
    const files = fs.readdirSync(IMAGE_DIR);
    files.forEach(file => {
      const filePath = path.join(IMAGE_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        fs.rmSync(filePath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(filePath);
      }
    });
  } else {
    fs.mkdirSync(IMAGE_DIR, { recursive: true });
  }
}

function clearFormatsDirectories() {
  const formatsDirs = [
    path.join(PROJECT_ROOT, 'formats', 'csv'),
    path.join(PROJECT_ROOT, 'formats', 'thirdrails'),
    path.join(PROJECT_ROOT, 'formats', 'hud')
  ];
  
  formatsDirs.forEach(dir => {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      files.forEach(file => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          fs.unlinkSync(filePath);
        }
      });
    }
  });
}

function copyTestImages(timetable) {
  // Use the images from the unit test folder: tests/unit/{timetable}/images/
  const fullPath = path.join(TESTS_DIR, 'unit', timetable, 'images');
  
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Test images directory not found: ${fullPath}`);
  }
  
  const files = fs.readdirSync(fullPath);
  
  if (files.length === 0) {
    throw new Error(`No images found in: ${fullPath}`);
  }
  
  files.forEach(file => {
    const filePath = path.join(fullPath, file);
    const stat = fs.statSync(filePath);
    // Only copy files, not subdirectories
    if (stat.isFile()) {
      fs.copyFileSync(filePath, path.join(IMAGE_DIR, file));
    }
  });
  console.log(`  Copied ${files.filter(f => fs.statSync(path.join(fullPath, f)).isFile()).length} image(s) from unit/${timetable}/images`);
}

function compareFiles(actualPath, expectedPath, testId, fileType) {
  if (!fs.existsSync(expectedPath)) {
    console.log(`  ⚠️  Expected file not found: ${expectedPath}`);
    return false;
  }
  
  if (!fs.existsSync(actualPath)) {
    console.log(`  ❌ Actual file not found: ${actualPath}`);
    return false;
  }
  
  const actual = fs.readFileSync(actualPath, 'utf8');
  const expected = fs.readFileSync(expectedPath, 'utf8');
  
  if (actual === expected) {
    console.log(`  ✅ ${fileType} matches expected output`);
    return true;
  } else {
    console.log(`  ❌ ${fileType} does NOT match expected output`);
    console.log(`     Expected: ${expectedPath}`);
    console.log(`     Actual: ${actualPath}`);
    
    // Show first difference
    const actualLines = actual.split('\n');
    const expectedLines = expected.split('\n');
    for (let i = 0; i < Math.max(actualLines.length, expectedLines.length); i++) {
      if (actualLines[i] !== expectedLines[i]) {
        console.log(`     First difference at line ${i + 1}:`);
        console.log(`       Expected: ${expectedLines[i]}`);
        console.log(`       Actual:   ${actualLines[i]}`);
        break;
      }
    }
    return false;
  }
}

function runTest(test) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Running Test #${test.id}: ${test.description || test.command}`);
  console.log('='.repeat(80));
  
  try {
    // Clear images and formats directories
    clearImageDirectory();
    clearFormatsDirectories();
    copyTestImages(test.timetable);
  } catch (error) {
    console.log(`  ⚠️  Skipping test: ${error.message}`);
    return { passed: null, skipped: true, testId: test.id };
  }
  
  // Run the extraction command
  const command = `node extract.js ${test.command}`;
  console.log(`  Command: ${command}`);
  
  try {
    execSync(command, { cwd: PROJECT_ROOT, stdio: 'inherit' });
  } catch (error) {
    console.log(`  ❌ Command failed with error: ${error.message}`);
    return { passed: false, testId: test.id };
  }
  
  // Compare outputs
  let allPassed = true;
  
  const timetableDir = path.join(TESTS_DIR, 'unit', test.timetable);
  const testDir = path.join(timetableDir, `test_${test.id}`);
  
  // Compare OCR raw output (shared across all tests)
  const actualOcr = path.join(PROJECT_ROOT, 'ocr_raw_output.txt');
  const expectedOcr = path.join(timetableDir, 'ocr_raw_output.txt');
  if (!compareFiles(actualOcr, expectedOcr, test.id, 'OCR raw output')) {
    allPassed = false;
  }
  
  // Compare format outputs dynamically
  const formatComparisons = [
    { name: 'CSV', actualDir: path.join(PROJECT_ROOT, 'formats', 'csv'), expectedDir: path.join(testDir, 'formats', 'csv') },
    { name: 'ThirdRails', actualDir: path.join(PROJECT_ROOT, 'formats', 'thirdrails'), expectedDir: path.join(testDir, 'formats', 'thirdrails') },
    { name: 'HUD', actualDir: path.join(PROJECT_ROOT, 'formats', 'hud'), expectedDir: path.join(testDir, 'formats', 'hud') }
  ];
  
  formatComparisons.forEach(format => {
    if (fs.existsSync(format.expectedDir)) {
      const expectedFiles = fs.readdirSync(format.expectedDir).filter(file => {
        const stat = fs.statSync(path.join(format.expectedDir, file));
        return stat.isFile();
      });
      
      if (expectedFiles.length === 0) {
        console.log(`  ⚠️  No expected ${format.name} files found in ${format.expectedDir}`);
        allPassed = false;
      } else if (expectedFiles.length > 1) {
        console.log(`  ⚠️  Multiple expected ${format.name} files found (should be 1): ${expectedFiles.join(', ')}`);
        allPassed = false;
      } else {
        // Compare the single file
        const expectedFile = expectedFiles[0];
        const actualPath = path.join(format.actualDir, expectedFile);
        const expectedPath = path.join(format.expectedDir, expectedFile);
        
        if (!compareFiles(actualPath, expectedPath, test.id, `${format.name} output`)) {
          allPassed = false;
        }
      }
    } else {
      console.log(`  ⚠️  Expected ${format.name} directory not found: ${format.expectedDir}`);
      allPassed = false;
    }
  });
  
  return { passed: allPassed, testId: test.id };
}

function main() {
  console.log('Starting test suite...\n');
  
  // Get optional timetable filter from command line
  const timetableFilter = process.argv[2];
  
  const unitDir = path.join(TESTS_DIR, 'unit');
  
  // Get all timetable folders from the unit directory
  let timetableFolders = [];
  if (fs.existsSync(unitDir)) {
    timetableFolders = fs.readdirSync(unitDir).filter(item => {
      const itemPath = path.join(unitDir, item);
      return fs.statSync(itemPath).isDirectory();
    });
  }
  
  if (timetableFolders.length === 0) {
    console.log('No timetable folders found in tests/unit/');
    process.exit(1);
  }
  
  // Filter by specific timetable if provided
  if (timetableFilter) {
    if (!timetableFolders.includes(timetableFilter)) {
      console.log(`Timetable folder not found: ${timetableFilter}`);
      console.log(`Available timetables: ${timetableFolders.join(', ')}`);
      process.exit(1);
    }
    timetableFolders = [timetableFilter];
    console.log(`Running tests for timetable: ${timetableFilter}\n`);
  } else {
    console.log(`Running tests for all timetables: ${timetableFolders.join(', ')}\n`);
  }
  
  // Build list of tests to run by scanning the unit folder structure
  let testsToRun = [];
  for (const timetable of timetableFolders) {
    const timetableDir = path.join(unitDir, timetable);
    const testDirs = fs.readdirSync(timetableDir).filter(item => {
      const itemPath = path.join(timetableDir, item);
      return fs.statSync(itemPath).isDirectory() && item.startsWith('test_');
    }).sort(); // Sort to ensure consistent ordering
    
    // Get all test configs for this timetable
    const timetableTests = testsConfig.tests
      .filter(t => t.timetable === timetable)
      .sort((a, b) => a.id - b.id);
    
    // Map each test folder to the corresponding test config by matching test ID
    for (const testDir of testDirs) {
      const testId = parseInt(testDir.replace('test_', ''));
      const testConfig = timetableTests.find(t => t.id === testId);
      
      if (testConfig) {
        testsToRun.push(testConfig);
      } else {
        // Fallback: no matching config in tests.json
        const fallbackConfig = {
          id: testId,
          timetable: timetable,
          description: `Test ${testId}`,
          command: '',
          images: timetable
        };
        console.log(`Using dynamic config for ${timetable}/test_${testId}`);
        testsToRun.push(fallbackConfig);
      }
    }
  }
  
  if (testsToRun.length === 0) {
    console.log('No tests found to run');
    process.exit(1);
  }
  
  const results = [];
  
  for (let i = 0; i < testsToRun.length; i++) {
    const test = testsToRun[i];
    const result = runTest(test);
    result.timetable = test.timetable; // Add timetable info to result
    result.description = test.description; // Add description to result
    results.push(result);
    
    // Check if next test is for a different timetable or if this is the last test
    const isLastTest = i === testsToRun.length - 1;
    const nextTestDifferentTimetable = !isLastTest && testsToRun[i + 1].timetable !== test.timetable;
    
    if (isLastTest || nextTestDifferentTimetable) {
      // Clear images and formats after completing all tests for this timetable
      console.log(`\nClearing images and formats after ${test.timetable} tests...`);
      clearImageDirectory();
      clearFormatsDirectories();
    }
  }
  
  // Summary
  console.log('\n' + '='.repeat(80));
  console.log('TEST SUMMARY');
  console.log('='.repeat(80));
  
  if (timetableFilter) {
    // Single folder report
    const passed = results.filter(r => r.passed === true).length;
    const failed = results.filter(r => r.passed === false).length;
    const skipped = results.filter(r => r.skipped).length;
    
    console.log(`Timetable: ${timetableFilter}`);
    console.log(`Total tests: ${results.length}`);
    console.log(`Passed: ${passed} ✅`);
    console.log(`Failed: ${failed} ❌`);
    console.log(`Skipped: ${skipped} ⚠️`);
    
    if (skipped > 0) {
      console.log('\nSkipped tests (no images):');
      results.filter(r => r.skipped).forEach(r => {
        console.log(`  - Test #${r.testId}`);
      });
    }
    
    if (failed > 0) {
      console.log('\nFailed tests:');
      results.filter(r => !r.passed && !r.skipped).forEach(r => {
        console.log(`  - Test #${r.testId}: ${r.description}`);
      });
      process.exit(1);
    } else if (passed === 0) {
      console.log('\n⚠️  No tests were run (all skipped)');
      process.exit(0);
    } else {
      console.log('\n🎉 All tests passed!');
      process.exit(0);
    }
  } else {
    // Multiple folders report - group by timetable
    const timetableResults = {};
    
    results.forEach(r => {
      if (!timetableResults[r.timetable]) {
        timetableResults[r.timetable] = { passed: 0, failed: 0, skipped: 0, total: 0 };
      }
      timetableResults[r.timetable].total++;
      if (r.passed === true) timetableResults[r.timetable].passed++;
      else if (r.passed === false) timetableResults[r.timetable].failed++;
      else if (r.skipped) timetableResults[r.timetable].skipped++;
    });
    
    console.log('Results by timetable:\n');
    let allPassed = true;
    
    Object.keys(timetableResults).sort().forEach(timetable => {
      const stats = timetableResults[timetable];
      const status = stats.failed > 0 ? '❌' : stats.passed === 0 ? '⚠️' : '✅';
      console.log(`${status} ${timetable}: ${stats.passed}/${stats.total} passed`);
      if (stats.failed > 0) {
        console.log(`   Failed: ${stats.failed}`);
        allPassed = false;
      }
      if (stats.skipped > 0) {
        console.log(`   Skipped: ${stats.skipped}`);
      }
    });
    
    console.log(`\nOverall:`);
    const totalPassed = results.filter(r => r.passed === true).length;
    const totalFailed = results.filter(r => r.passed === false).length;
    const totalSkipped = results.filter(r => r.skipped).length;
    
    console.log(`Total tests: ${results.length}`);
    console.log(`Passed: ${totalPassed} ✅`);
    console.log(`Failed: ${totalFailed} ❌`);
    console.log(`Skipped: ${totalSkipped} ⚠️`);
    
    if (totalFailed > 0) {
      console.log('\nFailed tests:');
      results.filter(r => !r.passed && !r.skipped).forEach(r => {
        console.log(`  - ${r.timetable} Test #${r.testId}: ${r.description}`);
      });
      process.exit(1);
    } else if (totalPassed === 0) {
      console.log('\n⚠️  No tests were run (all skipped)');
      process.exit(0);
    } else {
      console.log('\n🎉 All tests passed!');
      process.exit(0);
    }
  }
}

main();
