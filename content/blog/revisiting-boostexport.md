---
title: Revisiting boostexport
date: 2026-08-03
description: Explaining the tree representation and some minor improvements
tags: [tech]
---

## I. Context

To understand what is written here, you need to read [Building an ML Inference API, Part IV](/blog/building-ml-inference-part-4) and be somewhat familiar with my project [boostexport](https://github.com/haiilong/boostexport), which exports trained XGBoost, LightGBM, or CatBoost models into self-contained static classes for native inference in C# or Go.

**Sections:**

1. [How to represent the trees](#ii-how-to-represent-the-trees)
    - [Data-array form](#_1-data-array-form)
    - [Handling oblivious trees](#_2-handling-oblivious-trees)
2. [Some minor performance improvements](#iii-some-minor-performance-improvements)
    - [Replace sigmoid for binary label](#_1-replace-sigmoid-for-binary-label)
    - [Improve fixed-depth CatBoost trees](#_2-improve-fixed-depth-catboost-trees)
    - [Use `byte[]` and `ushort[]` for Feature indexes](#_3-use-byte-and-ushort-for-feature-indexes)
    - [Use local variables for XGBoost multiclass scores](#_4-use-local-variables-for-xgboost-multiclass-scores)
    - [Strange behavior for multiclass LightGBM](#_5-strange-behavior-for-multiclass-lightgbm)
3. [Closing note](#iv-closing-note)

## II. How to represent the trees

Reading back the blog, I realized I missed a crucial explanation of how the trees are represented in the data-array form, so I am going to explain that in depth now.

### 1. Data-array form

Consider this small regression tree:

```text
                    f2 <= 1.5?
                   /          \
             f0 <= 0.2?       leaf: 1.2
              /       \
       leaf: -0.4    leaf: 0.8
```

Written directly in C#, it would look like this:

```csharp
if (features[2] <= 1.5)
{
    if (features[0] <= 0.2)
        return -0.4;

    return 0.8;
}

return 1.2;
```

What we will do now is assign an integer index to every node:

```text
Index 0: split on f2 <= 1.5
Index 1: split on f0 <= 0.2
Index 2: leaf -0.4
Index 3: leaf  0.8
Index 4: leaf  1.2
```

The order of the nodes is the pre-order traversal of the tree.

And we transform them into five arrays of length 5: Feature, Threshold, Left, Right, Value:

```text
Index        0     1     2     3     4
----------------------------------------
Feature      2     0     0     0     0
Threshold   1.5   0.2   0.0   0.0   0.0
Left         1     2    -1    -1    -1
Right        4     3     0     0     0
Value       0.0   0.0  -0.4   0.8   1.2
```

A non-leaf's `Feature` is the index of the feature; its children's indexes are at `Left` and `Right`; the comparison to go left or right is based on the `Threshold`; and its `Value` is always 0.

A leaf uses `Left = -1` as its marker and only its `Value` matters.

The generated C# is roughly:

```csharp
private static readonly byte[] Feature = [2, 0, 0, 0, 0];
private static readonly double[] Threshold = [1.5, 0.2, 0.0, 0.0, 0.0];
private static readonly int[] Left = [1, 2, -1, -1, -1];
private static readonly int[] Right = [4, 3, 0, 0, 0];
private static readonly double[] Value = [0.0, 0.0, -0.4, 0.8, 1.2];
```

`Feature` is a `byte[]` here because the model has fewer than 256 features. Larger models automatically use `ushort[]` or `int[]`. I will talk more about this in the next part.

All asymmetric trees share the same evaluator, which just traverses left or right based on the threshold and returns when it hits a leaf:

```csharp
private static double Eval(int node, ReadOnlySpan<double> features)
{
    while (true)
    {
        if (Left[node] < 0)
            return Value[node];

        double value = features[Feature[node]];

        if (value <= Threshold[node])
            node = Left[node];
        else
            node = Right[node];
    }
}
```

Suppose our inference input is

```text
f0 = 0.6
f2 = 1.1
```

The traversal is:

```text
Start at node 0

node 0:
    f2 = 1.1
    1.1 <= 1.5 is true
    move to Left[0], which is node 1

node 1:
    f0 = 0.6
    0.6 <= 0.2 is false
    move to Right[1], which is node 3

node 3:
    Left[3] is -1, so this is a leaf
    return Value[3], which is 0.8
```

We can generalize this to a forest by appending every tree to the same arrays and keeping a separate `Roots` array to mark where each tree begins:

```text
All nodes:

| tree 0 nodes | tree 1 nodes | tree 2 nodes | tree 3 nodes |
  ^              ^              ^              ^
  Roots[0]       Roots[1]       Roots[2]       Roots[3]
```

```csharp
public static double Predict(ReadOnlySpan<double> features)
{
   double score = BaseScore;

   for (int i = 0; i < TreeCount; i++)
       score += Eval(Roots[i], features);

   return score;
}
```

### 2. Handling oblivious trees

CatBoost normally trains symmetric trees, also called oblivious trees. Every node at a given level uses the same split.

A depth-three tree can be described by three questions:

```text
Level 0: f2 > 1.5?
Level 1: f0 > 0.2?
Level 2: f4 > 3.0?
```

There is no need for `Left` and `Right` arrays. Each answer becomes one bit in the leaf index:

```text
bit 0 = result from level 0
bit 1 = result from level 1
bit 2 = result from level 2
```

For example:

```text
Level 0: true  -> bit 0 = 1
Level 1: false -> bit 1 = 0
Level 2: true  -> bit 2 = 1

Leaf bits:     101
Leaf index:      5
```

The result of this inference is then `LeafValues[5]`.

The evaluator builds that number with bitwise OR:

```csharp
int leafIndex = 0;

if (features[feature0] > border0)
    leafIndex |= 1; // 001

if (features[feature1] > border1)
    leafIndex |= 2; // 010

if (features[feature2] > border2)
    leafIndex |= 4; // 100

return LeafValues[leafOffset + leafIndex];
```

A depth-three tree always has `2³`, or eight, leaves. A depth-six tree has 64.

The generated arrays are therefore closer to this:

```text
SplitFeature = [2, 0, 4, ...]
SplitBorder  = [1.5, 0.2, 3.0, ...]
LeafValues   = [leaf0, leaf1, ..., leaf7, ...]
```

## III. Some minor performance improvements

### 1. Replace sigmoid for binary label

A binary boosting model produces a raw score, often called a logit. Probability prediction applies sigmoid:

```text
sigmoid(x) = 1 / (1 + exp(-x))
```

The original label method reused probability prediction:

```csharp
public static int Predict(ReadOnlySpan<double> features)
    => PredictProbability(features) >= 0.5 ? 1 : 0;
```

That is convenient, but it calls `Math.Exp` for a result that does not need a probability. If you plot the sigmoid function on Desmos, it is clear that `sigmoid(x) >= 0.5` is the same as `x >= 0`, so the check only needs the sign of the raw score:

```csharp
public static int Predict(ReadOnlySpan<double> features)
    => PredictScore(features) >= 0.0 ? 1 : 0;
```

If the caller asks for probability, we still compute sigmoid.

### 2. Improve fixed-depth CatBoost trees

As mentioned above, CatBoost's default trees are symmetric, e.g., a depth-3 tree has 3 splits and 8 leaves. The original evaluator used arrays to find each tree's split range, depth, and leaf range:

```csharp
int splitOffset = TreeSplitOffset[treeIndex];
int depth = TreeDepth[treeIndex];

// Evaluate the tree...

return LeafValues[TreeLeafOffset[treeIndex] + leafIndex];
```

This representation can handle trees with different depths, but many CatBoost models use one depth throughout:

```text
Tree 0: depth 3
Tree 1: depth 3
Tree 2: depth 3
...
```

Once the exporter knows the depth is uniform, the offsets are arithmetic:

```text
Tree 0 split offset = 0 × 3 = 0
Tree 1 split offset = 1 × 3 = 3
Tree 2 split offset = 2 × 3 = 6

Tree 0 leaf offset = 0 × 8 = 0
Tree 1 leaf offset = 1 × 8 = 8
Tree 2 leaf offset = 2 × 8 = 16
```

The generated code becomes:

```csharp
int splitOffset = treeIndex * TreeDepth;
int leafOffset = treeIndex * (1 << TreeDepth);
```

This removes hot reads from three metadata arrays:

```text
TreeSplitOffset[]
TreeDepth[]
TreeLeafOffset[]
```

The exporter checks the depths before choosing this form. A variable-depth model keeps the original metadata arrays and generic evaluator.

We can go further and remove the level loop as well. The generic code was:

```csharp
for (int level = 0; level < depth; level++)
{
    int split = splitOffset + level;

    if (features[SplitFeature[split]] > SplitBorder[split])
        leafIndex |= 1 << level;
}
```

For a known depth of three, the generator can write three fixed comparisons:

```csharp
int split0 = splitOffset;
if (features[SplitFeature[split0]] > SplitBorder[split0])
    leafIndex |= 1;

int split1 = splitOffset + 1;
if (features[SplitFeature[split1]] > SplitBorder[split1])
    leafIndex |= 2;

int split2 = splitOffset + 2;
if (features[SplitFeature[split2]] > SplitBorder[split2])
    leafIndex |= 4;
```

The fixed code removes `level < depth` (compare + branch), `level++`, `splitOffset + level` and `1 << level` (variable shift). Importantly, the generated code grows with tree depth, not tree count. A model with 1,000 depth-3 trees still gets one 3-level helper rather than 1,000 separate blocks.

This unrolling should produce a measurable gain as RyuJIT's loop unroller would not do this (you can check this if you have an IL Viewer).

### 3. Use byte[] and ushort[] for Feature indexes

The node-array evaluator reads a feature index at every split. Tree traversal jumps between nodes according to feature values, so compact indexes give the CPU a better chance of finding the next index in cache.

Now, the exporter chooses the array type from the largest feature index:

| Largest feature index | Generated type |
|---:|---|
| 0 to 255 | `byte[]` |
| 256 to 65,535 | `ushort[]` |
| Above 65,535 | `int[]` |

### 4. Use local variables for XGBoost multiclass scores

A multiclass model has one raw score per class. A three-class XGBoost model stores its trees interleaved by boosting round:

```text
Roots[0] = round 0, class 0
Roots[1] = round 0, class 1
Roots[2] = round 0, class 2
Roots[3] = round 1, class 0
Roots[4] = round 1, class 1
Roots[5] = round 1, class 2
...
```

The root index is:

```text
round × number of classes + class
```

The general evaluator accumulated into an array:

```csharp
double[] scores = (double[])ClassBase.Clone();

for (int classIndex = 0; classIndex < NumClasses; classIndex++)
{
    for (int tree = 0; tree < TreesPerClass; tree++)
    {
        scores[classIndex] +=
            Eval(Roots[classIndex + tree * NumClasses], features);
    }
}
```

For a small, known class count, the generator now uses local variables:

```csharp
double score0 = ClassBase[0];
double score1 = ClassBase[1];
double score2 = ClassBase[2];

for (int round = 0; round < TreesPerClass; round++)
{
    int tree = round * NumClasses;

    score0 += Eval(Roots[tree], features);
    score1 += Eval(Roots[tree + 1], features);
    score2 += Eval(Roots[tree + 2], features);
}

return [score0, score1, score2];
```

This removes the inner class loop and repeated `scores[classIndex]` access. The JIT can keep the three scores in registers, and tree traversal follows XGBoost's interleaved storage order.

The exporter limits this specialization to eight classes so generated methods do not become unreasonably large. Models with more classes retain the general array loop.

### 5. Strange behavior for multiclass LightGBM

When benchmarking, the change above improved XGBoost multiclass throughput by about 16% in repeated runs (using the models in the demo folder). Applying the same thing to LightGBM gave no improvement.

But if I split the loop into multiple loops, each one updating a single score:

```csharp
double score0 = 0;
double score1 = 0;
double score2 = 0;

for (int tree = 0; tree < TreesPerClass; tree++)
    score0 += Eval(Roots[0 + tree * NumClasses], features);

for (int tree = 0; tree < TreesPerClass; tree++)
    score1 += Eval(Roots[1 + tree * NumClasses], features);

for (int tree = 0; tree < TreesPerClass; tree++)
    score2 += Eval(Roots[2 + tree * NumClasses], features);

return [score0, score1, score2];
```

This version improved the LightGBM multiclass workload by roughly 12%, when it is basically the same thing, just with the outer loop unrolled.

Here's the weird thing: the interleaved version does strictly less scaffolding work. One loop of N iterations with three bodies, versus three loops of N iterations. Same number of `Eval` calls, one-third the loop increments and back-edges, three independent FP accumulator chains instead of one, and sequential rather than strided access through `Roots`. On paper it should win.

Since it loses, the cause has to be something order-sensitive inside `Eval` (in the split version, all class-0 trees are eval-ed first, then all class-1 trees, and so on), or a codegen accident. Going deeper into this is stepping too far into JIT compiler design.

## IV. Closing note

With this, I published v1.0.0 of boostexport. Besides the uncommon objectives like poisson, this should work fine.
