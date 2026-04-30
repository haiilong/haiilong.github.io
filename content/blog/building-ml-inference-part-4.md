---
title: Building an ML Inference API, Part IV
date: 2026-04-28
description: Converting LightGBM models into native .NET inference
tags: [tech]
---

## Background

By the time the FastAPI inference service from [Part II](/blog/building-ml-inference-part-2) was in production, the .NET side around it had all the usual machinery: HTTP clients, retries, timeouts, circuit breakers, tracing. All necessary, but still plumbing.

Sometimes even a clean network call was too expensive.

Most of what we were serving was LightGBM regression. Training, feature engineering, and retraining schedules all belonged in Python. Inference itself was just trees, which means comparisons and additions.

That raised a simple question:

**Why call another service to execute something that could just run inside the same process?**

Instead of hosting the model behind an endpoint, I started experimenting with translating trained LightGBM models directly into C#. Then callers could invoke a method instead of making an HTTP request.

That removed a few things from the runtime path:

* the network hop
* retry logic around inference
* the Python process
* a separate service to scale

It worked. For regression models especially, the mapping from tree structure to code is almost literal. You can generate C# source from the model, compile it into a DLL, and do inference natively inside .NET with no model file at runtime.

There is one catch though: giant generated `if/else` trees get ugly fast.

At some point it becomes cleaner to stop generating so much branching code and instead represent the trees as data, then evaluate them with a small runtime.

That ended up being the approach I preferred.

This post walks through both.

1. Why trees can be represented directly as code
2. How LightGBM trees map to C#
3. A tiny concrete example
4. Generating the if/else version
5. Where that starts to break down
6. An evaluator that treats the model as data
7. Extending the same idea to classification

Regression first, because it makes the idea easiest to see.

---

## A regression tree is already code

One mental shift helps a lot:

A decision tree is not really something you translate into `if/else`. It already *is* `if/else`.

Take a toy tree:

* If `strength_diff <= -2.11`

  * predict `0.3145`
* Else

  * predict `0.7237`

That is literally:

```csharp
if (features[5] <= -2.11)
    return 0.3145;
else
    return 0.7237;
```

That is not an approximation. That *is* the model.

And that’s why tree models are unusually portable compared with a lot of other ML models.

---

## Boosting is just many trees adding corrections

A LightGBM regression model is an ensemble:

```text
prediction =
    tree1(x)
  + tree2(x)
  + tree3(x)
  + ...
```

Each tree contributes a little correction.

In code:

```csharp
public static double Predict(double[] f)
{
    double score = 0;

    score += Tree0(f);
    score += Tree1(f);
    score += Tree2(f);

    return score;
}
```

Each `TreeN` is nested branching logic.

That is the whole inference loop for regression.

---

## Reading a LightGBM tree

A tree dump might look something like:

```text
split_feature: strength_diff
threshold: -1.18

left_child:
   split_feature: minute
   threshold: 15
   left_child: leaf=0.48
   right_child: leaf=0.62

right_child:
   leaf=1.03
```

Which maps directly to:

```csharp
if (strengthDiff <= -1.18)
{
    if (minute <= 15)
        return 0.48;
    else
        return 0.62;
}
else
{
    return 1.03;
}
```

Pretty much one to one:

| LightGBM      | C#             |
| ------------- | -------------- |
| split_feature | feature index  |
| threshold     | comparison     |
| left child    | if branch      |
| right child   | else branch    |
| leaf value    | returned value |
| ensemble      | sum of trees   |

Once that clicks, everything else follows naturally.

---

## Tiny example

Suppose a model has:

```text
Tree=0
num_leaves=3
split_feature=5 7
threshold=-1.18 15
left_child=1 -1
right_child=2 -2
leaf_value=0.48 0.62 1.03
```

Generated C#:

```csharp
static double Tree0(double[] f)
{
    if (f[5] <= -1.18)
    {
        if (f[7] <= 15)
            return 0.48;
        else
            return 0.62;
    }

    return 1.03;
}
```

That is the tree.

If you have 300 trees, generate 300 methods. And this is surprisingly workable.

---

## Verifying inference

Using one row from my model:

```csharp
var result = Model.Predict([
1.2699999809265137,
3.380000114440918,
0.7300000190734863,
1.6299999952316284,
4.650000095367432,
-2.1100001335144043,
1.0,
28.0,
0.0,
0.0,
2.0,
2.0,
-2.0,
0.0,
2.0,
2.0,
-2.0,
7.0,
-0.40880000591278076,
1.0871999263763428,
427465.0
]);
```

Expected:

```text
0.31458735
```

Generated predictor matched exactly, which is very good.

---

## Generating the C#

This should absolutely be generated. Do not hand write trees. For any real model, it gets impossible very quickly. I used Python to generate the C# code, but the language of the exporter does not matter much.

```python
import lightgbm as lgb

booster = lgb.Booster(model_file="model.txt")
model_dump = booster.dump_model()
```

Trees live in:

```python
model_dump["tree_info"]
```

Recursive emitter:

```python
def emit_node(node, indent=1):
    pad = "    " * indent

    if "leaf_value" in node:
        return f"{pad}return {node['leaf_value']};\n"

    feature = node["split_feature"]
    threshold = node["threshold"]

    code = []

    code.append(
        f"{pad}if (features[{feature}] <= {threshold})\n"
        f"{pad}{{\n"
    )

    code.append(emit_node(node["left_child"], indent+1))

    code.append(
        f"{pad}}}\n"
        f"{pad}else\n"
        f"{pad}{{\n"
    )

    code.append(emit_node(node["right_child"], indent+1))

    code.append(f"{pad}}}\n")

    return "".join(code)
```

Generate methods:

```python
for i, tree in enumerate(model_dump["tree_info"]):
    print(f"static double Tree{i}(double[] features)")
    print("{")
    print(emit_node(tree["tree_structure"]))
    print("}")
```

The basic version is quite small.

---

## Why I liked this

### Native inference

The generated predictor does not need a Python runtime or a LightGBM dependency. It is just .NET code.

### Fast

Inference becomes a small set of cheap operations:

* comparisons
* branches
* additions

### Deployment gets simple

The model becomes source. Ship a DLL and you’ve shipped the model.

### Debugging is easier

You can inspect actual decision paths. That can be useful in pricing or risk sensitive systems.

---

## Where it starts breaking down

Say:

* 500 trees
* depth 8
* ~255 nodes each

That’s potentially:

```text
127,500 node checks
```

Now generated code gets huge.

You start getting:

* giant files
* ugly diffs
* slower compile times
* questionable JIT behavior

It still works. For example, one of my models had 150 trees and 25 features, and the generated C# was about 130k lines. If you use Rider or another IDE that parses C#, you will feel it slow down.

That pushed me toward a better representation.

---

## Represent the model as data

Instead of generating giant branch forests, export the model the way it already exists internally:

* feature arrays
* thresholds
* child pointers
* leaf values

Then use a tiny evaluator:

```csharp
private static double Eval(int node, ReadOnlySpan<double> f)
{
    while (true)
    {
        if (IsLeaf[node])
            return Value[node];

        if (f[Feature[node]] <= Threshold[node])
            node = Left[node];
        else
            node = Right[node];
    }
}
```

Boosting:

```csharp
public static double Predict(ReadOnlySpan<double> f)
{
    double score = 0;

    for (int i = 0; i < TreeCount; i++)
        score += Eval(Roots[i], f);

    return score;
}
```

Still exact inference. Just much cleaner.

---

## Why I ended up preferring this

Compared with giant generated if/else:

* much smaller generated source
* one evaluator method
* cleaner diffs
* easier codegen
* friendlier for JIT

And source size grows mostly with model data, not duplicated branching syntax.

---

## Classification extends naturally

### Binary classification

Same trees. Usually sum logits, then apply sigmoid:

```text
probability = sigmoid(sum)
```

```csharp
static double Sigmoid(double x)
{
   return 1 / (1 + Math.Exp(-x));
}
```

Then threshold. Same traversal. Different output transform.

---

## Multiclass

Multiclass uses the same traversal idea.

Often:

```text
num_classes × boosting_rounds trees
```

Accumulate per class:

```csharp
double[] scores = new double[3];

scores[0] += Tree0(f);
scores[1] += Tree1(f);
scores[2] += Tree2(f);
```

Then softmax:

```csharp
static double[] Softmax(double[] x)
{
    var exp = x.Select(Math.Exp).ToArray();
    var sum = exp.Sum();
    return exp.Select(v => v / sum).ToArray();
}
```

Same trees, different aggregation.

---

## Validate everything

Before optimizing, verify generated inference against the original model.

For example:

```csharp
Assert.True(
    diff < 1e-4,
    $"Row {i} mismatch. Expected={expected}, Actual={actual}"
);
```

Always verify correctness with multiple test cases, not just one row.

---

## LightGBM fields not carried into C#

It is worth looking at one real LightGBM tree from a text model dump. I shortened the arrays so it is easier to read, but the shape is the same:

```text
Tree=1
num_leaves=5
split_feature=11 2 17 18
split_gain=437375 65423.8 30686.3 15052.8
threshold=1.0000000180025095e-35 0.94499999284744274 15.500000000000002 0.47699999809265142
decision_type=2 2 2 2
left_child=1 -1 -2 -3
right_child=2 3 -4 -5
leaf_value=0.0017963732109250652 -0.0029226866697364827 0.012002031587390959 -0.0066260868638778623 0.0074389293400878229
leaf_weight=419486 548345 401639 1175784 300693
leaf_count=419486 548345 401639 1175784 300693
internal_value=3.11874e-06 0.00803391 -0.00396084 0.00239001
internal_weight=5.49575e+06 1.8162e+06 3.67954e+06 617181
internal_count=5495746 1816203 3679543 617181
is_linear=0
shrinkage=0.02
```

As you can see, the dump contains more than the C# inference runtime needs. The generated code keeps the fields used to walk the tree and return a prediction: `split_feature`, `threshold`, `left_child`, `right_child`, and `leaf_value`. A few other fields are useful to understand, but they do not show up in the final arrays.

`shrinkage` is the tree learning rate. In many LightGBM text dumps, the shrinkage has already been folded into `leaf_value`, so the C# predictor can just add the tree result directly:

```csharp
score += Eval(Roots[i], f);
```

If shrinkage were not already folded into the leaves, the runtime would need to multiply each tree output by a per tree shrinkage value. For the dumped models I was working with, ignoring the explicit `shrinkage` field was correct because the leaf values already contained it.

`is_linear` tells you whether the tree uses normal constant leaves or linear leaves. The exporter assumes `is_linear=0`, where each leaf returns one scalar value. That matches the usual LightGBM tree:

```text
if feature <= threshold:
    return leaf_value
```

If `is_linear=1`, each leaf contains a small linear model instead of a single number. That needs a different inference engine. This exporter does not support that case.

`internal_value` is the value stored at an internal split node. You can think of it as the prediction at that point if the tree stopped there. It is useful for diagnostics, but inference does not return from internal nodes, so the C# code does not need it.

`internal_weight` is the weighted amount of training data that reached an internal node. LightGBM uses it while training for split decisions, regularization, and pruning. Once the tree is trained, inference only needs to know which branch to take.

`leaf_weight` is similar, but for a leaf. It tells you how much weighted training data ended up in that leaf. It can be useful when inspecting the model, but prediction only needs `leaf_value`.

So the flat C# representation is intentionally small:

```text
Feature
Threshold
Left
Right
Value
IsLeaf
Roots
```

That is basically a tiny runtime for executing tree bytecode. The original LightGBM dump has training metadata too, but the generated predictor only carries what it needs to reproduce inference.

---

## Code

Check my GitHub repo for the full exporter:

[https://github.com/haiilong/export_lgbm_universal_cs](https://github.com/haiilong/export_lgbm_universal_cs)
