# TSW Timetable Extractor - Testing

This directory contains the test suite for the timetable extractor.

## Structure

```
tests/
├── run_tests.js           # Main test runner
├── generate_expected.js   # Helper to generate expected results
├── tests.json            # Test configuration
├── test_1/               # Test case 1
│   ├── images/           # Test images for this case
│   ├── expected_ocr_raw_output.txt
│   ├── expected_output.csv
│   ├── expected_thirdrails.csv
│   └── expected_hud.csv
├── test_2/               # Test case 2
│   └── ...
└── README.md            # This file
```

## Test Cases

1. **Test 1**: Basic test with no arguments
2. **Test 2**: Test with platform argument only
3. **Test 3**: Test with platform and destination
4. **Test 4**: Test with formatted service name (asterisks)

## Running Tests

To run all tests:
```powershell
node tests/run_tests.js
```

## Creating a New Test

### Step 1: Add test images
Create a directory for your test images:
```powershell
mkdir tests/test_X/images
```

Copy your test images into this directory.

### Step 2: Update tests.json
Add your test configuration to `tests.json`:
```json
{
  "id": X,
  "description": "Description of what this test does",
  "command": "arguments to pass to extract.js",
  "images": "test_X\\images",
  "expected_ocr": "test_X\\expected_ocr_raw_output.txt",
  "expected_csv": "test_X\\expected_output.csv",
  "expected_csv_filename": "name_of_output_file.csv",
  "expected_thirdrails": "test_X\\expected_thirdrails.csv",
  "expected_hud": "test_X\\expected_hud.csv"
}
```

### Step 3: Generate expected results
Run the generate script to create expected output files:
```powershell
node tests/generate_expected.js X
```

This will:
1. Copy the test images to the main timetable_images directory
2. Run the extraction with your specified command
3. Copy the outputs to the test_X directory as expected results

### Step 4: Verify expected results
Review the generated files in `test_X/` to ensure they are correct.

### Step 5: Run the test
```powershell
node tests/run_tests.js
```

## Test Output Comparison

The test runner compares the following files:
- **OCR raw output**: `ocr_raw_output.txt`
- **CSV output**: The main CSV format in `formats/csv/`
- **ThirdRails CSV**: The thirdrails format in `formats/thirdrails/`
- **HUD CSV**: The HUD format in `formats/hud/`

All files must match exactly for a test to pass.

## Troubleshooting

If a test fails, the runner will show:
- Which file(s) didn't match
- The first line where differences were found
- Expected vs actual values

To update expected results after fixing code:
```powershell
node tests/generate_expected.js <test_id>
```
