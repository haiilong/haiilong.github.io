---
title: Building an ML Inference API, Part I
date: 2025-09-02
description: Some history. The naive approach given the architecture back then.
tags: [tech]
---

## Background

Back in early 2020, I was working on a Software Engineering (SWE) team whose stack was .NET (.NET Core 2.2, to be precise) and SQL Server, with all projects deployed to Windows Server VMs. I worked closely with a Data Science team that operated strictly in Python. Even though the two teams had independent workstreams, my responsibility often involved integrating Machine Learning (ML) models into production. The workflow typically looked like this:

1. A .NET project reads from a database or data source for input.
2. It formats the input and passes it to the Python-trained ML model.
3. The model runs a prediction on the input.
4. The result is passed back to the .NET project to be used downstream.

One of the main challenges was making this process seamless, fast, and scalable (up to a few hundred calls per second), all while ensuring Python-trained models worked effectively within a .NET environment.

This problem stuck with me. It remained relevant even in early 2023, when most projects in the company were fully Dockerized and managed by Kubernetes (k8s), no longer running on Windows Server VMs.

I want to document the problems and the solutions I devised, given the unique constraints I had to work with.

## When .NET was running in Windows VMs

At the time, for "security" and "we-don't-have-enough-non-C#-experts" reasons, building Python projects on these VMs was not permitted.

The task was to run an XGBoost model based on specific conditions. The call frequency was low (a few calls every 15 minutes), so performance wasn't the top priority; getting it to run at all was. The simplest solution we came up with was to drop a Python script onto the same VM and invoke it as a subprocess from our .NET application.

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

The `jsonString` here is the feature array. Pull it from a DTO or wherever the input lives, then form the string.

```csharp
var jsonString = "[0.52,0.1,0.8,1.5,2.2,1.4]";
var pythonPath = @"python";
var scriptPath = @"predict.py";
```

Next, we configure `ProcessStartInfo`. This is the critical part: we tell Windows to suppress the black command prompt window and redirect the output so we can read it in C#.

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

Finally, we execute the process. This is a synchronous operation, meaning the C# app will wait for Python to finish before continuing.

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

For our use case, this hacked-together solution worked surprisingly well. A nice bonus: updating the model was as simple as deploying a new `xgboost_model.json` to all the servers (i.e., remoting in and swapping the file).

## When .NET was running in Windows VMs (but now we had to care about scale)

Within half a year, a similar task came up, but this time the model would be called very frequently and asynchronously. We're talking an average of 400,000 times per day, with distinct peak and off-peak periods.

The task was to integrate this model into a .NET Web API deployed across 10 VMs. The model would be invoked in one of the API's endpoints.

The previous approach doesn't scale at all. We were spinning up a new OS process for every single prediction. For 400k requests a day, that means the server has to start the Python runtime, load the libraries, load the model into memory, run the prediction, and tear everything down, 400,000 times. The overhead and CPU jitter alone would be crippling.

The ideal solution would have been to deploy a Python Web API to those VMs and let it serve as a dedicated inference service, keeping the model loaded in memory and handling requests over HTTP. But given the earlier restrictions, that wasn't on the table.

So the question became: can we run XGBoost directly in C#? And, naturally, has anyone actually done it?

I found two options:

1. [PicNet XGBoost.Net](https://github.com/PicNet/XGBoost.Net), a community library built on top of the native `xgboost.dll` (Windows) or `libxgboost.so` (Linux).
2. [ML.NET](https://github.com/dotnet/machinelearning), Microsoft's own ML framework, where the approach is to convert the XGBoost model to ONNX (Open Neural Network Exchange) and run inference through ML.NET.

Option 2 felt like overkill for a pure inference problem. ONNX interoperability is a powerful concept, but it's bringing a cannon to a knife fight.

Option 1, on the other hand, was direct: a thin wrapper around the native C++ XGBoost library. It just worked. I did run into issues ensuring the native binaries (`xgboost.dll`) and model files were copied to the right output directories and referenced correctly, but that was more a setup fumble on my part than a problem with the library itself.

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

This eliminated all the process-spawning overhead. The model is loaded once at startup, and predictions happen entirely in memory. It handled 400k requests per day across 10 VMs without breaking a sweat, and arguably faster than a Python Web API would have been, since there's no network hop and no need to think about how to scale the Python side.

There was one significant caveat, though. Because the model is loaded once at startup, updating it requires restarting the application. Since we wanted to avoid forcing a restart every time the data science team retrained the model, we added two admin endpoints: one to upload a new model file, and one to trigger an in-memory reload.

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

At the time of writing, there is a newer and better-maintained XGBoost library for C# available at [XGBoostSharp](https://github.com/mdabros/XGBoostSharp), built on the same foundations. If you need a native implementation today, use that one. For inference-only use cases, you can ignore the training capabilities entirely.

Then, ...

One day, the team switched from XGBoost to LightGBM. Both are gradient boosting frameworks, but while XGBoost is known for its execution speed and model performance, LightGBM is often praised for being faster still and using less memory, which is a meaningful advantage when working with large datasets.

There is a LightGBM wrapper for .NET called [LightGBM.Net](https://github.com/rca22/LightGBM.Net), which saved us here (Thank God!). HOWEVER, I couldn't get it to locate `lib_lightgbm.dll` correctly no matter where I placed the file on the server. In the end, I forked the repository and extended it to accept an absolute path for the DLL.

## Closing thoughts

Path issues and dependency management in Windows VM environments became a recurring theme. Running native libraries inside .NET solved the performance problem, but it introduced a new set of maintenance headaches. What if the data science team wanted to integrate a CatBoost model next? We needed a better way to abstract this complexity away. I'll cover that in Part II, which is, if anything, more relevant in 2025.