# Code Style Guide

Based on [TigerStyle](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md)

## On Simplicity And Elegance

Simplicity is not a free pass. It's not in conflict with our design goals. It need not be a
concession or a compromise.

Rather, simplicity is how we bring our design goals together, how we identify the "super idea" that
solves the axes simultaneously, to achieve something elegant.

Simplicity and elegance are unpopular because they require hard work and discipline to achieve.

Contrary to popular belief, simplicity is also not the first attempt but the hardest revision. It's
easy to say "let's do something simple", but to do that in practice takes thought, multiple passes,
many sketches, and still we may have to throw one away.

The hardest part, then, is how much thought goes into everything.

We spend this mental energy upfront, proactively rather than reactively, because we know that when
the thinking is done, what is spent on the design will be dwarfed by the implementation and testing,
and then again by the costs of operation and maintenance.

An hour or day of design is worth weeks or months in production. The simple and elegant systems
tend to be easier and faster to design and get right, more efficient in execution, and much more
reliable.

## Technical Debt

What could go wrong? What's wrong? Which question would we rather ask? The former, because code,
like steel, is less expensive to change while it's hot. A problem solved in production is many times
more expensive than a problem solved in implementation, or a problem solved in design.

Since it's hard enough to discover showstoppers, when we do find them, we solve them. We don't allow
potential latency spikes, or exponential complexity algorithms to slip through.

A "zero technical debt" policy means doing it right the first time. This
is important because the second time may not transpire, and because doing good work, that we can be
proud of, builds momentum.

We know that what we ship is solid. We may lack crucial features, but what we have meets our design
goals. This is the only way to make steady incremental progress, knowing that the progress we have
made is indeed progress.

## Safety

The rules act like the seat-belt in your car: initially they are perhaps a little uncomfortable,
but after a while their use becomes second-nature and not using them becomes unimaginable.

### The Power of Ten: NASA's Rules for Safety-Critical Code

NASA's Power of Ten — Rules for Developing Safety Critical Code will change the way you code
forever. These ten rules provide a foundation for writing verifiable, safe code:

1. **Keep control flow simple** - Avoid `goto` statements, avoid recursion, and keep control flow
   straightforward. Simple control flow is easier to understand, verify, and reason about. Recursion
   makes it difficult to prove bounded execution and can lead to stack overflows.

2. **All loops must have fixed limits** - Every loop needs a provable maximum number of iterations.
   This prevents infinite loops and makes the code's worst-case execution time analyzable. The bound
   should be statically verifiable whenever possible.

3. **No dynamic memory after startup** - Avoid `malloc`, `free`, and dynamic allocation after
   initialization. Dynamic memory allocation can fail unpredictably, cause fragmentation, lead to
   memory leaks, and make timing analysis impossible. Allocate everything you need at startup.

4. **Functions stay short** - Limit functions to approximately 60 lines (one printed page). Short
   functions are easier to understand, test, and verify. If a function exceeds this limit, it's
   likely doing too much and should be decomposed.

5. **Use lots of assertions** - Average at least 2 assertions per function to catch bugs early.
   Assertions document assumptions, detect violations immediately, and serve as executable
   specifications. They're invaluable for finding bugs during testing and development.

6. **Minimize variable scope** - Declare variables in the smallest scope possible. This reduces the
   amount of code that can interact with a variable, making it easier to reason about the variable's
   state and reducing the chance of misuse.

7. **Check all return values** - Never ignore what functions return unless you have explicit
   justification documented in a comment. Unchecked errors are a primary source of catastrophic
   failures in production systems.

8. **Keep preprocessor simple** - Minimize use of macros and conditional compilation (`#ifdef`).
   Heavy preprocessor use makes code difficult to parse, analyze with static tools, and verify
   correctness. Prefer language features over macro tricks.

9. **Limit pointer use** - Restrict to one level of pointer dereferencing (avoid `**ptr`), and
   avoid function pointers where possible. Multiple levels of indirection make code harder to
   analyze and verify, and function pointers prevent static call graph analysis.

10. **Zero compiler warnings** - Enable all compiler warnings, use static analysis tools, and fix
    everything. Warnings often indicate real bugs. Treat warnings as errors to maintain a clean
    codebase where new warnings are immediately visible.

To expand on these principles:

- Use **only very simple, explicit control flow** for clarity. **Do not use recursion** to ensure
  that all executions that should be bounded are bounded. Use **only a minimum of excellent
  abstractions** but only if they make the best sense of the domain. Abstractions are never zero
  cost. Every abstraction introduces the risk of a leaky abstraction.

- **Put a limit on everything** because, in reality, this is what we expect—everything has a limit.
  For example, all loops and all queues must have a fixed upper bound to prevent infinite loops or
  tail latency spikes. This follows the fail-fast principle so that violations are detected sooner
  rather than later. Where a loop cannot terminate (e.g. an event loop), this must be asserted.

- Use explicitly-sized types (like `uint32_t`, `int64_t`) for everything, avoid architecture-specific
  types (like `size_t`) where possible.

- **Assertions detect programmer errors. Unlike operating errors, which are expected and which must
  be handled, assertion failures are unexpected. The only correct way to handle corrupt code is to
  crash. Assertions downgrade catastrophic correctness bugs into liveness bugs. Assertions are a
  force multiplier for discovering bugs by fuzzing.**

  - **Assert all function arguments and return values, pre/postconditions and invariants.** A
    function must not operate blindly on data it has not checked. The purpose of a function is to
    increase the probability that a program is correct. Assertions within a function are part of how
    functions serve this purpose. The assertion density of the code must average a minimum of two
    assertions per function.

  - **Pair assertions.** For every property you want to enforce, try to find at least two different
    code paths where an assertion can be added. For example, assert validity of data right before
    writing it to disk, and also immediately after reading from disk.

  - On occasion, you may use a blatantly true assertion instead of a comment as stronger
    documentation where the assertion condition is critical and surprising.

  - Split compound assertions: prefer `assert(a); assert(b);` over `assert(a and b);`.
    The former is simpler to read, and provides more precise information if the condition fails.

  - Use single-line `if` to assert an implication: `if (a) assert(b)`.

  - **Assert the relationships of compile-time constants** as a sanity check, and also to document
    and enforce subtle invariants or type sizes.
    Compile-time assertions are extremely powerful because they are able to check a program's design
    integrity _before_ the program even executes.

  - **The golden rule of assertions is to assert the _positive space_ that you do expect AND to
    assert the _negative space_ that you do not expect** because where data moves across the
    valid/invalid boundary between these spaces is where interesting bugs are often found. This is
    also why **tests must test exhaustively**, not only with valid data but also with invalid data,
    and as valid data becomes invalid.

  - Assertions are a safety net, not a substitute for human understanding. With simulation testing,
    there is the temptation to trust the fuzzer. But a fuzzer can prove only the presence of bugs,
    not their absence. Therefore:
    - Build a precise mental model of the code first,
    - encode your understanding in the form of assertions,
    - write the code and comments to explain and justify the mental model to your reviewer,
    - and use VOPR as the final line of defense, to find bugs in your and reviewer's understanding
      of code.

- All memory must be statically allocated at startup. **No memory may be dynamically allocated (or
  freed and reallocated) after initialization.** This avoids unpredictable behavior that can
  significantly affect performance, and avoids use-after-free. As a second-order effect, it is our
  experience that this also makes for more efficient, simpler designs that are more performant and
  easier to maintain and reason about, compared to designs that do not consider all possible memory
  usage patterns upfront as part of the design.

- Declare variables at the **smallest possible scope**, and **minimize the number of variables in
  scope**, to reduce the probability that variables are misused.

- Restrict the length of function bodies to reduce the probability of poorly structured code. We
  enforce a **hard limit of 70 lines per function**.

  Splitting code into functions requires taste. There are many ways to cut a wall of code into
  chunks of 70 lines, but only a few splits will feel right. Some rules of thumb:

  - Good function shape is often the inverse of an hourglass: a few parameters, a simple return
    type, and a lot of meaty logic between the braces.
  - Centralize control flow. When splitting a large function, try to keep all switch/if
    statements in the "parent" function, and move non-branchy logic fragments to helper
    functions. Divide responsibility. All control flow should be handled by _one_ function, the rest shouldn't
    care about control flow at all. In other words,
    ["push `if`s up and `for`s down"](https://matklad.github.io/2023/11/15/push-ifs-up-and-fors-down.html).
  - Similarly, centralize state manipulation. Let the parent function keep all relevant state in
    local variables, and use helpers to compute what needs to change, rather than applying the
    change directly. Keep leaf functions pure.

- Appreciate, from day one, **all compiler warnings at the compiler's strictest setting**.

- Whenever your program has to interact with external entities, **don't do things directly in
  reaction to external events**. Instead, your program should run at its own pace. Not only does
  this make your program safer by keeping the control flow of your program under your control, it
  also improves performance for the same reason (you get to batch, instead of context switching on
  every event). Additionally, this makes it easier to maintain bounds on work done per time period.

Beyond these rules:

- Compound conditions that evaluate multiple booleans make it difficult for the reader to verify
  that all cases are handled. Split compound conditions into simple conditions using nested
  `if/else` branches. Split complex `else if` chains into `else { if { } }` trees. This makes the
  branches and cases clear. Again, consider whether a single `if` does not also need a matching
  `else` branch, to ensure that the positive and negative spaces are handled or asserted.

- Negations are not easy! State invariants positively. When working with lengths and indexes, this
  form is easy to get right (and understand):

  ```
  if (index < length) {
    // The invariant holds.
  } else {
    // The invariant doesn't hold.
  }
  ```

  This form is harder, and also goes against the grain of how `index` would typically be compared to
  `length`, for example, in a loop condition:

  ```
  if (index >= length) {
    // It's not true that the invariant holds.
  }
  ```

- All errors must be handled. An analysis of production failures in distributed data-intensive
  systems found that the majority of catastrophic failures could have been prevented by simple
  testing of error handling code. Almost all (92%) of catastrophic system failures are the result
  of incorrect handling of non-fatal errors explicitly signaled in software.

- **Always motivate, always say why**. Never forget to say why. Because if you explain the rationale
  for a decision, it not only increases the hearer's understanding, and makes them more likely to
  adhere or comply, but it also shares criteria with them with which to evaluate the decision and
  its importance.

- **Explicitly pass options to library functions at the call site, instead of relying on the
  defaults**. This improves readability but most of all avoids latent, potentially
  catastrophic bugs in case the library ever changes its defaults.

## Performance

The lack of back-of-the-envelope performance sketches is the root of all evil.

- Think about performance from the outset, from the beginning. **The best time to solve performance,
  to get the huge 1000x wins, is in the design phase, which is precisely when we can't measure or
  profile.** It's also typically harder to fix a system after implementation and profiling, and the
  gains are less. So you have to have mechanical sympathy. Like a carpenter, work with the grain.

- **Perform back-of-the-envelope sketches with respect to the four resources (network, disk, memory,
  CPU) and their two main characteristics (bandwidth, latency).** Sketches are cheap. Use sketches
  to be “roughly right” and land within 90% of the global maximum.

- Optimize for the slowest resources first (network, disk, memory, CPU) in that order, after
  compensating for the frequency of usage, because faster resources may be used many times more. For
  example, a memory cache miss may be as expensive as a disk fsync, if it happens many times more.

- Distinguish between the control plane and data plane. A clear delineation between control plane
  and data plane through the use of batching enables a high level of assertion safety without losing
  performance.

- Amortize network, disk, memory and CPU costs by batching accesses.

- Let the CPU be a sprinter doing the 100m. Be predictable. Don't force the CPU to zig zag and
  change lanes. Give the CPU large enough chunks of work. This comes back to batching.

- Be explicit. Minimize dependence on the compiler to do the right thing for you.

  In particular, extract hot loops into stand-alone functions with primitive arguments.
  That way, the compiler doesn't need to prove that it can cache struct's fields in registers, and a
  human reader can spot redundant computations easier.

## Developer Experience

There are only two hard things in Computer Science: cache invalidation, naming things, and
off-by-one errors.

### Naming Things

- **Get the nouns and verbs just right.** Great names are the essence of great code, they capture
  what a thing is or does, and provide a crisp, intuitive mental model. They show that you
  understand the domain. Take time to find the perfect name, to find nouns and verbs that work
  together, so that the whole is greater than the sum of its parts.

- Use `snake_case` for function, variable, and file names. The underscore is the closest thing we
  have as programmers to a space, and helps to separate words and encourage descriptive names.

- Do not abbreviate variable names, unless the variable is a primitive integer type used as an
  argument to a sort function or matrix calculation. Use long form arguments in scripts: `--force`,
  not `-f`. Single letter flags are for interactive usage.

- Use proper capitalization for acronyms (`VSRState`, not `VsrState`).

- Add units or qualifiers to variable names, and put the units or qualifiers last, sorted by
  descending significance, so that the variable starts with the most significant word, and ends with
  the least significant word. For example, `latency_ms_max` rather than `max_latency_ms`. This will
  then line up nicely when `latency_ms_min` is added, as well as group all variables that relate to
  latency.

- Infuse names with meaning. For example, `allocator` is a good, if boring name,
  but `general_purpose_allocator` and `arena_allocator` are excellent. They inform the reader
  about the specific allocation strategy being used.

- When choosing related names, try hard to find names with the same number of characters so that
  related variables all line up in the source. For example, as arguments to a memcpy function,
  `source` and `target` are better than `src` and `dest` because they have the second-order effect
  that any related variables such as `source_offset` and `target_offset` will all line up in
  calculations and slices. This makes the code symmetrical, with clean blocks that are easier for
  the eye to parse and for the reader to check.

- When a single function calls out to a helper function or callback, prefix the name of the helper
  function with the name of the calling function to show the call history. For example,
  `read_sector()` and `read_sector_callback()`.

- Callbacks go last in the list of parameters. This mirrors control flow: callbacks are also
  _invoked_ last.

- _Order_ matters for readability (even if it doesn't affect semantics). On the first read, a file
  is read top-down, so put important things near the top. The `main` function goes first.

  The same goes for classes and structs, order matters: fields then types then methods.

  If a nested type is complex, make it a top-level class or struct.

  At the same time, not everything has a single right order. When in doubt, consider sorting
  alphabetically, taking advantage of big-endian naming.

- Don't overload names with multiple meanings that are context-dependent. Avoid reusing terminology
  across different parts of the system if it can cause confusion.

- Think of how names will be used outside the code, in documentation or communication. For example,
  a noun is often a better descriptor than an adjective or present participle, because a noun can be
  directly used in correspondence without having to be rephrased. Compare `replica.pipeline` vs
  `replica.preparing`. The former can be used directly as a section header in a document or
  conversation, whereas the latter must be clarified. Noun names compose more clearly for derived
  identifiers, e.g. `config.pipeline_max`.

- Use named arguments or options structures when arguments can be mixed up. A function taking
  multiple arguments of the same type should use an options structure. If an argument can be `null`,
  it should be named so that the meaning of `null` literal at the call site is clear.

  Dependencies like allocators or tracers that are singletons with unique types should
  be passed through constructors positionally, from the most general to the most specific.

- **Write descriptive commit messages** that inform and delight the reader, because your commit
  messages are being read.

- Don't forget to say why. Code alone is not documentation. Use comments to explain why you wrote
  the code the way you did. Show your workings.

- Don't forget to say how. For example, when writing a test, think of writing a description at the
  top to explain the goal and methodology of the test, to help your reader get up to speed, or to
  skip over sections, without forcing them to dive in.

- Comments are sentences, with a space after the slash, with a capital letter and a full stop, or a
  colon if they relate to something that follows. Comments are well-written prose describing the
  code, not just scribblings in the margin. Comments after the end of a line _can_ be phrases, with
  no punctuation.

### Cache Invalidation

- Don't duplicate variables or take aliases to them. This will reduce the probability that state
  gets out of sync.

- If you don't mean a function argument to be copied when passed by value, and if the argument type
  is more than 16 bytes, then pass the argument by const reference. This will catch bugs where the
  caller makes an accidental copy on the stack before calling the function.

- **Shrink the scope** to minimize the number of variables at play and reduce the probability that
  the wrong variable is used.

- Calculate or check variables close to where/when they are used. **Don't introduce variables before
  they are needed.** Don't leave them around where they are not. This will reduce the probability of
  a POCPOU (place-of-check to place-of-use), a distant cousin to the infamous
  [TOCTOU](https://en.wikipedia.org/wiki/Time-of-check_to_time-of-use). Most bugs come down to a
  semantic gap, caused by a gap in time or space, because it's harder to check code that's not
  contained along those dimensions.

- Use simpler function signatures and return types to reduce dimensionality at the call site, the
  number of branches that need to be handled at the call site, because this dimensionality can also
  be viral, propagating through the call chain. For example, as a return type, `void` is simpler than
  `bool`, which is simpler than an integer, which is simpler than an optional/nullable type, which is
  simpler than a result/error type.

- Ensure that functions run to completion without suspending, so that precondition assertions are
  true throughout the lifetime of the function. These assertions are useful documentation without a
  suspend, but may be misleading otherwise.

- Be on your guard for **buffer bleeds**. This is a
  buffer underflow, the opposite of a buffer overflow, where a buffer is not fully utilized, with
  padding not zeroed correctly. This may not only leak sensitive information, but may cause
  deterministic guarantees to be violated.

- Use newlines to **group resource allocation and deallocation**, i.e. before the resource
  allocation and after the corresponding cleanup/deallocation code, to make leaks easier to spot.

### Off-By-One Errors

- **The usual suspects for off-by-one errors are casual interactions between an `index`, a `count`
  or a `size`.** These are all primitive integer types, but should be seen as distinct types, with
  clear rules to cast between them. To go from an `index` to a `count` you need to add one, since
  indexes are _0-based_ but counts are _1-based_. To go from a `count` to a `size` you need to
  multiply by the unit. Again, this is why including units and qualifiers in variable names is
  important.

- Show your intent with respect to division. Use explicit rounding functions to show the reader
  you've thought through all the interesting scenarios where rounding may be involved.

### Style By The Numbers

- Use a code formatter consistently.

- Use 4 spaces of indentation, rather than 2 spaces, as that is more obvious to the eye at a
  distance.

- Hard limit all line lengths, without exception, to at most 100 columns for a good typographic
  "measure". Use it up. Never go beyond. Nothing should be hidden by a horizontal scrollbar. Let
  your editor help you by setting a column ruler. To wrap a function signature, call or data
  structure, add a trailing comma and let your formatter do the rest.

- Add braces to the `if` statement unless it fits on a single line for consistency and defense in
  depth against "goto fail;" bugs.

### Dependencies

A "zero dependencies" policy means minimizing external dependencies. Dependencies, in
general, inevitably lead to supply chain attacks, safety and performance risk, and slow install
times. For foundational infrastructure in particular, the cost of any dependency is further
amplified throughout the rest of the stack.

### Tooling

Similarly, tools have costs. A small standardized toolbox is simpler to operate than an array of
specialized instruments each with a dedicated manual. Choose a primary tool or language that
may not be the best for everything, but is good enough for most things. Invest into your tooling to
ensure that you can tackle new problems quickly, with a minimum of accidental complexity in your
local development environment.

The right tool for the job is often the tool you are already using—adding new tools has a higher
cost than many people appreciate.

For example, consider writing scripts in a compiled language rather than shell scripts.

This not only makes your scripts cross-platform and portable, but introduces type safety and
increases the probability that running your scripts will succeed for everyone on the team, instead of
hitting shell/OS-specific issues.

Standardizing on tooling is important to ensure that we reduce dimensionality, as the team,
and therefore the range of personal tastes, grows. This may be slower for you in the short term, but
makes for more velocity for the team in the long term.

## The Last Stage

At the end of the day, keep trying things out, have fun, and remember the principles:
safety, performance, and developer experience.
