---
title: Reduce Memory Footprint and Garbage Collection Pressure
date: 2025-02-17
description: Practical ways to reduce memory usage and garbage collection pressure.
tags: [tech]
---

Performance optimization along hot paths (frequent APIs) often comes down to memory allocation often comes down to managing memory allocations and reducing garbage collection pressure.

We explore a few .NET "Data Structures" that boosts this.

## I. ReadOnlySpan<T>

`ReadOnlySpan<T>` is a lightweight, stack only type that represents a read only view over a contiguous region of memory. Unlike traditional string operations or array slicing that create new copies of data, `ReadOnlySpan<T>` provides a zero allocation way to work with memory segments. Many modern APIs support `ReadOnlySpan<T>`

Think of it as pointer's APIs (not really but you can think like that).

`Span<T>` will allow you to modify the underlying data and `Memory<T>` and `ReadOnly<Memory<T>>` stay in the heap so you can use them with things like fields.

## Substring and Concat

Given

```csharp
private const string LongText = "The quick brown fox jumps over the lazy dog";
```

Compare

```csharp
public string Traditional()
{
    string first = LongText.Substring(4, 5);
    string second = LongText.Substring(10, 5);
    return first + second;
}
```

vs

```csharp
public string Span()
{
    ReadOnlySpan<char> span = LongText.AsSpan();
    ReadOnlySpan<char> first = span.Slice(4, 5);
    ReadOnlySpan<char> second = span.Slice(10, 5);

    return string.Concat(first, second);
}
```

Result:

![image-20250218-020246.png](/blog/reduce-memory-footprint-and-garbage-collection-pressure/image_20250218_020246.png)

## Number Parsing

Given

```csharp
private const string Numbers = "123,456,789";
```

Compare

```csharp
public List<int> Traditional()
{
    return Numbers.Split(',')
        .Select(int.Parse)
        .ToList();
}
```

vs

```csharp
public List<int> Span()
{
    ReadOnlySpan<char> span = Numbers.AsSpan();
    var result = new List<int>();
    
    while (span.Length > 0)
    {
        var commaPos = span.IndexOf(',');
        if (commaPos == -1)
        {
            result.Add(int.Parse(span));
            break;
        }
        
        result.Add(int.Parse(span[..commaPos]));
        span = span[(commaPos + 1)..];
    }
    
    return result;
}
```

Result:

![image-20250218-020623.png](/blog/reduce-memory-footprint-and-garbage-collection-pressure/image_20250218_020623.png)

## String Parsing

Given

```csharp
private const string searchString = "Unique";
    
private readonly string sourceString = Random.Shared.Next(10, 51)
    .ToString()
    .PadLeft(50, Random.Shared.Next(9, 12).ToString()[0])
    .Insert(Random.Shared.Next(35), searchString);
```

Compare

```csharp
public bool Traditional()
{
    return sourceString.Contains(searchString, StringComparison.OrdinalIgnoreCase);
}
```

vs

```csharp
public bool Span()
{
    ReadOnlySpan<char> sourceSpan = sourceString.AsSpan();
    ReadOnlySpan<char> searchSpan = searchString.AsSpan();
    
    return sourceSpan.Contains(searchSpan, StringComparison.OrdinalIgnoreCase);
}
```

Result:

![image-20250218-020846.png](/blog/reduce-memory-footprint-and-garbage-collection-pressure/image_20250218_020846.png)

## String Create

We will benchmark concatenation of a bunch of strings of size 3 to 8. This is the code

```csharp
using System.Text;

namespace Performance.Benchmarks;

[MemoryDiagnoser]
public class StringCreateBenchmarks
{
    private List<string> _strings = [];

    private const string _separator = ",";

    [Params(5, 25, 100, 500)]
    public int ListSize { get; set; }

    [IterationSetup]
    public void Init()
    {
        _strings = GenerateRandomWords(ListSize);
    }
    
    [Benchmark]
    public string StringConcat()
    {
        var result = string.Empty;
        for (var i = 0; i < _strings.Count; i++)
        {
            result += _strings[i];
            if (i < _strings.Count - 1)
                result += _separator;
        }

        return result;
    }
    
    [Benchmark]
    public string StringJoin()
    {
        return string.Join(',', _strings);
    }
    
    [Benchmark]
    public string StringBuilder()
    {
        var sb = new StringBuilder();
        for (var i = 0; i < _strings.Count; i++)
        {
            sb.Append(_strings[i]);
            if (i < _strings.Count - 1)
            {
                sb.Append(_separator);
            }
        }

        return sb.ToString();
    }
    
    [Benchmark]
    public string StringCreate()
    {
        var totalSize = 0;
        for (var i = 0; i < _strings.Count; i++)
        {
            totalSize += _strings[i].Length;
        }
        
        totalSize += _separator.Length * _strings.Count - 1;
        
        return string.Create(totalSize, (_strings, _separator), (chars, state) =>
        {
            var offset = 0;
                
            var separatorSpan = state._separator.AsSpan();
            for(var i = 0; i < state._strings.Count; i++)
            {
                var currentStr = state._strings[i];                    
                currentStr.AsSpan().CopyTo(chars[offset..]);
                offset += currentStr.Length;
                
                if (i < state._strings.Count - 1)
                {
                    separatorSpan.CopyTo(chars[offset..]);
                    offset += state._separator.Length;
                }
            }
        });
    }

    private static readonly Random r = new();
    private static List<string> GenerateRandomWords(int count) =>
    [
        ..Enumerable.Range(0, count)
            .Select(_ => 
                new string(Enumerable.Range(0, r.Next(3, 8))
                    .Select(_ => (char)r.Next('a', 'z' + 1))
                    .ToArray()))
    ];
}
```

Result:

![image-20250218-022012.png](/blog/reduce-memory-footprint-and-garbage-collection-pressure/image_20250218_022012.png)

## Json Key

Let's compare something as trivial as

```csharp
JsonDocument::RootElement.TryGetProperty("MyKey", out var _);
```

vs

```csharp
JsonDocument::RootElement.TryGetProperty("MyKey"u8, out var _);
```

Result:

![image-20250218-023528.png](/blog/reduce-memory-footprint-and-garbage-collection-pressure/image_20250218_023528.png)

## II. TryFormat and stackalloc

`TryFormat()` is a modern API for converting values to their string representations without allocating memory. Many built in types (numbers, dates, GUIDs, etc.) implement this method, allowing direct writing to a span buffer.

```csharp
public string FormatCurrency(decimal amount)
{
    Span<char> buffer = stackalloc char[32]; // Stack-allocated buffer
    if (amount.TryFormat(buffer, out int written, "C2"))
    {
        return new string(buffer[..written]);
    }
}
```

```csharp
public string FormatDateAndTime(DateTime dateTime)
{
    const string format = "yyyy-MM-dd HH:mm:ss";
    Span<char> buffer = stackalloc char[format.Length];
    
    if (dateTime.TryFormat(buffer, out int written, format))
    {
        return new string(buffer[..written]);
    }
    return dateTime.ToString(format);
}
```

Let's benchmark `TryFormat()` and `ToString()` for int, double and decimal. This is the code we will use for benchmarking

```csharp
namespace Performance.Benchmarks;

[MemoryDiagnoser]
public class NumberFormatBenchmarks
{
    private const int IntValue = 12345;
    private const double DoubleValue = 123.456;
    private const decimal DecimalValue = 123.456m;
    private readonly char[] _charBuffer = new char[100];
    
    [Benchmark]
    public string Int_ToString()
    {
        return IntValue.ToString();
    }

    [Benchmark]
    public bool Int_TryFormat()
    {
        return IntValue.TryFormat(_charBuffer, out _);
    }

    [Benchmark]
    public string Int_ToString_WithFormat()
    {
        return IntValue.ToString("D8");
    }

    [Benchmark]
    public bool Int_TryFormat_WithFormat()
    {
        return IntValue.TryFormat(_charBuffer, out _, "D8");
    }

    [Benchmark]
    public string Double_ToString()
    {
        return DoubleValue.ToString();
    }

    [Benchmark]
    public bool Double_TryFormat()
    {
        return DoubleValue.TryFormat(_charBuffer, out _);
    }

    [Benchmark]
    public string Double_ToString_WithFormat()
    {
        return DoubleValue.ToString("F2");
    }

    [Benchmark]
    public bool Double_TryFormat_WithFormat()
    {
        return DoubleValue.TryFormat(_charBuffer, out _, "F2");
    }

    [Benchmark]
    public string Decimal_ToString()
    {
        return DecimalValue.ToString();
    }

    [Benchmark]
    public bool Decimal_TryFormat()
    {
        return DecimalValue.TryFormat(_charBuffer, out _);
    }

    [Benchmark]
    public string Decimal_ToString_WithFormat()
    {
        return DecimalValue.ToString("C");
    }

    [Benchmark]
    public bool Decimal_TryFormat_WithFormat()
    {
        return DecimalValue.TryFormat(_charBuffer, out _, "C");
    }
    
    [Benchmark]
    public string Double_ToString_Culture()
    {
        return DoubleValue.ToString(System.Globalization.CultureInfo.InvariantCulture);
    }

    [Benchmark]
    public bool Double_TryFormat_Culture()
    {
        return DoubleValue.TryFormat(_charBuffer, out _, provider: System.Globalization.CultureInfo.InvariantCulture);
    }
}
```

Result:

![image-20250218-025153.png](/blog/reduce-memory-footprint-and-garbage-collection-pressure/image_20250218_025153.png)

Note:

`stackalloc` allows you to allocate memory directly on the stack rather than the heap. This is particularly useful for short lived, fixed size buffers. So don't do the below if you don't know the input length. The guideline is 1KB.

```csharp
Span<char> buffer = stackalloc char[input.Length * 2]; // TOO LARGE
```

## III. CollectionMarshal

This provides a set of methods to access the underlying data representations of collections. Basically think of it as changing a Collection to `ReadOnlySpan` . The equivalent to `AsSpan()` for Collection is

```csharp
Span<T> collectionSpan = CollectionsMarshal.AsSpan(list)
```

## Loop Benchmark

Let's compare looping through a List and aggregate items together using

* For

* ForEach

* AsSpan + For

* AsSpan + ForEach

* Linq Aggregate/ForEach

For list of different size

![image-20250218-024914.png](/blog/reduce-memory-footprint-and-garbage-collection-pressure/image_20250218_024914.png)

Takeaways:

* AsSpan is the fastest and allow For and ForEach to have similar performance

* As the list size increases, Linq is faster while traditional For and ForEach are slower

## IV. ArrayPool

Array pooling is a technique to reuse arrays instead of creating new ones, which helps reduce garbage collection pressure and memory fragmentation. .NET provides the `ArrayPool<T>` class for this purpose.

## Why Use Array Pooling?

* Reduced Memory Allocation: Instead of creating new arrays, you rent them from a pool

* Less Garbage Collection: Fewer allocations mean less GC pressure

* Better Performance: Reusing arrays is faster than creating new ones

* Memory Fragmentation: Helps prevent memory fragmentation in long running applications

## When To Use Array Pooling?

* High frequency array allocations: When your application frequently creates and disposes of arrays, especially in performance critical paths.

* Large arrays: When working with arrays larger than 85KB (as they go on the Large Object Heap).

* Memory sensitive scenarios: In environments where memory pressure is a concern, like in microservices or high scale applications.

* Temporary buffers: When you need temporary buffer space for operations like I/O or string manipulation. This is why you can never read CSV faster than a library.

## Why Not Use Array Pooling?

* Arrays are smaller than 1KB

* Arrays need to be long lived

* Exact size matching is required

* Working with sensitive data without proper clearing

* In simple, hot path operations where allocation overhead is minimal

* Working with large value types

## Then Use What?

* Direct array allocation (`new byte[]`)

* stackalloc for small, temporary buffers

* Dedicated arrays for long lived data

* Custom array implementations for special requirements

So how to use it

```csharp
public class PoolingComparison
{
    // Traditional approach - creates new arrays
    public void Traditional()
    {
        byte[] buffer1 = new byte[16384];
        byte[] buffer2 = new byte[16384];
        byte[] buffer3 = new byte[16384];
        
        // Use buffers...
        
        // Arrays become eligible for garbage collection
    }
    
    // Pooled approach - reuses arrays
    public void Pooled()
    {
        byte[] buffer1 = ArrayPool<byte>.Shared.Rent(16384);
        byte[] buffer2 = ArrayPool<byte>.Shared.Rent(16384);
        byte[] buffer3 = ArrayPool<byte>.Shared.Rent(16384);
        
        try
        {
            // Use buffers...
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer1);
            ArrayPool<byte>.Shared.Return(buffer2);
            ArrayPool<byte>.Shared.Return(buffer3);
        }
    }
}
```

Let's do some benchmark between these 2.

![image-20250218-030849.png](/blog/reduce-memory-footprint-and-garbage-collection-pressure/image_20250218_030849.png)

Extra:

Dictionary lookup vs Alternate lookup

I'll leave the code below

![image-20250228-033501.png](/blog/reduce-memory-footprint-and-garbage-collection-pressure/image_20250228_033501.png)

```csharp
private Dictionary<string, int> _dictionary = null!;
private Dictionary<string, int>.AlternateLookup<ReadOnlySpan<char>> _alternateLookup;
private string _keys = null!;

[GlobalSetup]
public void Setup()
{
    _dictionary = new Dictionary<string, int>
    {
        { "foo", 10 },
        { "bar", 20 },
        { "baz", 30 },
        { "qux", 40 },
        { "quux", 50 },
        { "corge", 60 },
        { "grault", 70 },
        { "garply", 80 },
        { "waldo", 90 },
        { "fred", 100 }
    };
    
    _alternateLookup = _dictionary.GetAlternateLookup<ReadOnlySpan<char>>();
    
    _keys = "foo, bar, baz, qux, quux, corge, grault, garply, waldo, fred";
}

[Benchmark(Baseline = true)]
public int StandardDictionaryLookup()
{
    var sum = 0;
    foreach (var key in _keys.Split(','))
    {
        var trimmedKey = key.Trim();
        sum += _dictionary[trimmedKey];
    }
    return sum;
}

[Benchmark]
public int AlternateLookup()
{
    var sum = 0;
    foreach (Range range in _keys.AsSpan().Split(','))
    {
        ReadOnlySpan<char> key = _keys.AsSpan(range).Trim();
        sum += _alternateLookup[key];
    }
    return sum;
}
```
