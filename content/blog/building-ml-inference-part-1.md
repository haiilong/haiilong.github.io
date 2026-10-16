---
title: Building an ML Inference API, Part I
date: 2025-09-02
description: Some history. The naive approach given the architecture back then.
tags: [tech]
---

## Background

Back in early 2020, I was working on a Software Engineering (SWE) team whose stack was .NET (.NET Core 2.2, to be precise) and SQL Server, with all projects deployed to Windows Server VMs. I worked closely with a Data Science team that operated strictly in Python. The two teams had separate workstreams, but I was often the one integrating Machine Learning (ML) models into production. The workflow usually looked like this:

1. A .NET project reads from a database or data source for input.
2. It formats the input and passes it to the Python-trained ML model.
3. The model runs a prediction on the input.
4. The result is passed back to the .NET project to be used downstream.

The hard part was making this fast and scalable (up to a few hundred calls per second) while getting Python-trained models to work inside a .NET environment.

This problem stuck with me. It was still relevant in early 2023, when most projects in the company were Dockerized and running on Kubernetes (k8s) instead of Windows Server VMs.

This series writes down the problems I ran into and how I solved them under the constraints at the time.

## I. When .NET was running in Windows VMs

At the time, for "security" and "we-don't-have-enough-non-C#-experts" reasons, building Python projects on these VMs was not permitted.

The task was to run an XGBoost model based on specific conditions. The call frequency was low (a few calls every 15 minutes), so performance didn't matter much; getting it to run at all did. The simplest solution was to drop a Python script onto the same VM and call it as a subprocess from our .NET application.

While building Python *projects* was strictly forbidden, apparently no one thought to ban installing the Python runtime and `pip` packages. We took the win.

### The Python script

Save this as `predict.py`. It loads the model, accepts a JSON string as an argument, and prints the result to standard output.

```python
import sys
import json
import xgboost as xgb
import numpy as np

# 1. Load the model (done once when the script starts)
model = xgb.XGBClassifier()
model.load_model("xgboost_model.json")

def run_inference(input_features):
    # Convert input list to numpy array and reshape for single prediction
    data = np.array(input_features).reshape(1, -1)
    prediction = model.predict(data)
    return float(prediction[0])

if __name__ == "__main__":
    try:
        # 2. Read the argument passed from C#
        input_json = sys.argv[1]
        features = json.loads(input_json)

        # 3. Run prediction and print result
        result = run_inference(features)
        print(result)
    except Exception as e:
        sys.stderr.write(str(e))
```

### The C# implementation

`jsonString` is the feature array. Build it from a DTO or wherever the input lives.

```csharp
var jsonString = "[0.52,0.1,0.8,1.5,2.2,1.4]";
var pythonPath = @"python";
var scriptPath = @"predict.py";
```

Next, configure `ProcessStartInfo` to hide the black command prompt window and redirect the output so C# can read it.

```csharp
var processStartInfo = new ProcessStartInfo
{
    FileName = pythonPath,
    // Wrap the JSON in quotes to handle spaces safely
    Arguments = $"{scriptPath} \"{jsonString}\"",

    // Crucial settings:
    RedirectStandardOutput = true, // Capture the print() result
    RedirectStandardError = true,  // Capture errors
    UseShellExecute = false,       // Required to redirect streams
    CreateNoWindow = true          // Don't pop up a black CMD window
};
```

Finally, run the process. It's synchronous, so the C# app waits for Python to finish before continuing.

```csharp
Process process = null;

try
{
    process = new Process { StartInfo = processStartInfo };
    process.Start();

    // Read the output synchronously (wait for Python to finish)
    var stringResult = process.StandardOutput.ReadToEnd();
    var errors = process.StandardError.ReadToEnd();

    process.WaitForExit();

    if (process.ExitCode == 0)
    {
        var prediction = double.Parse(stringResult);
        // Use prediction...
    }
    else
    {
        _logger.LogError($"Python script failed: {errors}");
    }
}
catch (Exception ex)
{
    _logger.LogError($"C# execution failed: {ex.Message}");
}
finally
{
    process?.Dispose();
}
```

This hacked-together solution worked surprisingly well for our use case. Updating the model was also as simple as deploying a new `xgboost_model.json` to all the servers (i.e., remoting in and swapping the file).

## II. When .NET was running in Windows VMs (but now we had to care about scale)

Within half a year, a similar task came up, but this model would be called much more often and asynchronously: about 400,000 times per day on average, with distinct peak and off-peak periods. It had to run inside one endpoint of a .NET Web API deployed across 10 VMs.

The previous approach doesn't scale, because it spins up a new OS process for every prediction. At 400k requests a day, the server would start the Python runtime, load the libraries, load the model into memory, run the prediction, and tear everything down 400,000 times. The overhead and CPU jitter alone would be too much.

Ideally we would have deployed a Python Web API to those VMs as a dedicated inference service that keeps the model in memory and handles requests over HTTP. The earlier restrictions ruled that out.

So could we run XGBoost directly in C#, and had anyone done it already?

I found two options:

1. [PicNet/XGBoost.Net](https://github.com/PicNet/XGBoost.Net), a community library built on top of the native `xgboost.dll` (Windows) or `libxgboost.so` (Linux).
2. [ML.NET](https://github.com/dotnet/machinelearning), Microsoft's own ML framework, where the approach is to convert the XGBoost model to ONNX (Open Neural Network Exchange) and run inference through ML.NET.

Option 2 felt like overkill for a pure inference problem. ONNX interoperability is useful, but here it was bringing a cannon to a knife fight.

Option 1 was a thin wrapper around the native C++ XGBoost library, and it just worked. I had some trouble getting the native binaries (`xgboost.dll`) and model files copied to the right output directories and referenced correctly, but that was my setup mistake, not the library's fault.

### The C# implementation

Using the PicNet library, the code looks surprisingly close to the Python version.

```csharp
using XGBoost.Lib;

// 1. Load the model
// You'll likely need to resolve the path via the executing or calling assembly. Fun times.
var modelPath = @"xgboost_model.json";
using var booster = XGBoost.Booster.BoosterLoad(modelPath);

// 2. Prepare the data
// Pass in an array of floats, which gets converted to a DMatrix internally
var features = new float[] { 0.52f, 0.1f, 0.8f, 1.5f, 2.2f, 1.4f };
var numRows = 1;
var numCols = features.Length;
using var matrix = XGBoost.DMatrix.FromMat(features, numRows, numCols, 0.0f);

// 3. Run inference
// Predict returns a 2D array [rows, output_classes]
var prediction = booster.Predict(matrix);

// 4. Parse the result
// For simple classification, grab the first value of the first row
var result = prediction[0][0];
```

This removed the process-spawning overhead. The model loads once at startup and predictions run entirely in memory. It handled 400k requests per day across 10 VMs without breaking a sweat, and was probably faster than a Python Web API would have been, since there's no network hop and no Python side to scale.

Since the model loads once at startup, updating it meant restarting the application. We didn't want a restart every time the data science team retrained the model, so we added two admin endpoints: one to upload a new model file, and one to trigger an in-memory reload.

```csharp
[ApiController]
[Route("api/[controller]")]
public class ModelAdminController : ControllerBase
{
    private static XGBoost.Booster _currentBooster;
    private static readonly object _lock = new object();

    // Endpoint 1: Upload the new model file to the server
    [HttpPost("upload")]
    public IActionResult UploadModel(IFormFile file)
    {
        if (file == null || file.Length == 0)
            return BadRequest("File is empty");

        var filePath = Path.Combine(Directory.GetCurrentDirectory(), "xgboost_model.json");

        using (var stream = new FileStream(filePath, FileMode.Create))
        {
            file.CopyTo(stream);
        }

        return Ok("Model file uploaded successfully. Call /reload to apply.");
    }

    // Endpoint 2: Reload the model into memory
    [HttpPost("reload")]
    public IActionResult ReloadModel()
    {
        try
        {
            lock (_lock)
            {
                _currentBooster?.Dispose();

                var modelPath = Path.Combine(Directory.GetCurrentDirectory(), "xgboost_model.json");
                _currentBooster = XGBoost.Booster.BoosterLoad(modelPath);
            }

            return Ok("Model reloaded successfully.");
        }
        catch (Exception ex)
        {
            return StatusCode(500, $"Failed to reload model: {ex.Message}");
        }
    }
}
```

There is now a newer, better-maintained XGBoost library for C#, [mdabros/XGBoostSharp](https://github.com/mdabros/XGBoostSharp), built on the same foundations. If you need a native implementation today, use that one. If you only need inference, you can ignore its training features.

Then, ...

One day, the team switched from XGBoost to LightGBM. Both are gradient boosting frameworks, but LightGBM is usually faster and uses less memory, which helps with large datasets.

There is a LightGBM wrapper for .NET called [LightGBM.Net](https://github.com/rca22/LightGBM.Net), which saved us here (Thank God!). HOWEVER, I couldn't get it to locate `lib_lightgbm.dll` correctly no matter where I placed the file on the server. In the end, I forked the repository and extended it to accept an absolute path for the DLL.

## Closing thoughts

Path issues and dependency management on Windows VMs kept coming up. Running native libraries inside .NET solved the performance problem but added maintenance work, and what if the data science team wanted a CatBoost model next? We needed a better way to abstract this away. I'll cover that in Part II, which is, if anything, more relevant in 2025.
