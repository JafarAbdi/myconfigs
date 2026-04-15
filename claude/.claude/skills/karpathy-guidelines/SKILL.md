---
name: karpathy-guidelines
description: Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code to avoid overcomplication, make surgical changes, surface assumptions, and define verifiable success criteria.
license: MIT
---

# Karpathy Guidelines

Behavioral guidelines to reduce common LLM coding mistakes, derived from [Andrej Karpathy's observations](https://x.com/karpathy/status/2015883857489522876) on LLM coding pitfalls.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

---

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### Example: Hidden Assumptions

**User Request:** "Add a feature to export user data"

**❌ Wrong (Hidden Assumptions)**

```python
def export_users(format='json'):
    """Export all users to a file."""
    users = User.query.all()

    if format == 'json':
        with open('users.json', 'w') as f:
            json.dump([u.to_dict() for u in users], f)
    elif format == 'csv':
        with open('users.csv', 'w') as f:
            writer = csv.DictWriter(f, fieldnames=['id', 'email', 'name'])
            writer.writeheader()
            writer.writerows([u.to_dict() for u in users])

    return f"Exported {len(users)} users"
```

Problems: Assumed ALL users (privacy?), file location, which fields, CSV fieldnames.

**✅ Correct (Surface Assumptions)**

```
Before implementing, I need to clarify:

1. **Scope**: Export all users or filtered subset? (privacy implications)
2. **Format**: Download file? Background job? API endpoint?
3. **Fields**: Which user fields? (some might be sensitive)
4. **Volume**: How many users typically? (affects approach)

Simplest approach: Add an API endpoint that returns paginated JSON.
What's your preference?
```

### Example: Multiple Interpretations

**User Request:** "Make the search faster"

**❌ Wrong (Pick Silently)**

```python
# Adds caching, database indexes, and async processing
# without asking which "faster" matters
```

**✅ Correct (Present Options)**

```
"Make the search faster" could mean:

1. **Faster response time** (< 100ms instead of 500ms)
   - Add database indexes, cache frequent queries

2. **Handle more concurrent searches** (throughput)
   - Add async/await, connection pooling

3. **Faster perceived speed** (UX)
   - Show partial results immediately, progressive loading

Current search takes ~500ms. Which aspect matters most?
```

---

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### Example: Over-abstraction

**User Request:** "Add a function to calculate discount"

**❌ Wrong (Overengineered)**

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass

class DiscountStrategy(ABC):
    @abstractmethod
    def calculate(self, amount: float) -> float:
        pass

class PercentageDiscount(DiscountStrategy):
    def __init__(self, percentage: float):
        self.percentage = percentage

    def calculate(self, amount: float) -> float:
        return amount * (self.percentage / 100)

class FixedDiscount(DiscountStrategy):
    def __init__(self, fixed_amount: float):
        self.fixed_amount = fixed_amount

    def calculate(self, amount: float) -> float:
        return min(self.fixed_amount, amount)

@dataclass
class DiscountConfig:
    strategy: DiscountStrategy
    min_purchase: float = 0.0
    max_discount: float = float('inf')

class DiscountCalculator:
    def __init__(self, config: DiscountConfig):
        self.config = config

    def apply_discount(self, amount: float) -> float:
        if amount < self.config.min_purchase:
            return 0
        discount = self.config.strategy.calculate(amount)
        return min(discount, self.config.max_discount)

# Usage requires 30+ lines of setup for a simple calculation
```

**✅ Correct (Simple)**

```python
def calculate_discount(amount: float, percent: float) -> float:
    """Calculate discount amount. percent should be 0-100."""
    return amount * (percent / 100)

# Usage
discount = calculate_discount(100.0, 10.0)  # $10 off
```

**When to add complexity:** Only when you actually need multiple discount types. Refactor then.

### Example: Speculative Features

**User Request:** "Save user preferences to database"

**❌ Wrong (Unnecessary Features)**

```python
class PreferenceManager:
    def __init__(self, db, cache=None, validator=None):
        self.db = db
        self.cache = cache or InMemoryCache()
        self.validator = validator or DefaultValidator()

    def save(self, user_id: int, prefs: dict,
             merge: bool = True,
             validate: bool = True,
             notify: bool = False) -> bool:
        """Save preferences with optional merging, validation, and notifications."""
        # ... 50+ lines of code for features nobody asked for
```

**✅ Correct (Just What Was Asked)**

```python
def save_preferences(db, user_id: int, preferences: dict):
    """Save user preferences to database."""
    db.execute(
        "UPDATE users SET preferences = ? WHERE id = ?",
        (json.dumps(preferences), user_id)
    )
```

**Add later if needed:** Caching, validation, merging—when the requirement emerges.

---

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### Example: Drive-by Refactoring

**User Request:** "Fix the bug where empty emails crash the validator"

**❌ Wrong (Too Much)**

```diff
  def validate_user(user_data):
-     # Check email format
-     if not user_data.get('email'):
+     """Validate user data."""
+     email = user_data.get('email', '').strip()
+
+     # Validate email
+     if not email:
          raise ValueError("Email required")
-
-     # Basic email validation
-     if '@' not in user_data['email']:
+     if '@' not in email or '.' not in email.split('@')[1]:
          raise ValueError("Invalid email")

-     # Check username
-     if not user_data.get('username'):
+     # Validate username
+     username = user_data.get('username', '').strip()
+     if not username:
          raise ValueError("Username required")
+     if len(username) < 3:
+         raise ValueError("Username too short")
```

Problems: "Improved" email validation, added username validation, changed comments, added docstring.

**✅ Correct (Surgical)**

```diff
  def validate_user(user_data):
      # Check email format
-     if not user_data.get('email'):
+     email = user_data.get('email', '')
+     if not email or not email.strip():
          raise ValueError("Email required")

      # Basic email validation
-     if '@' not in user_data['email']:
+     if '@' not in email:
          raise ValueError("Invalid email")
```

Only changed: The specific lines that fix empty email handling.

### Example: Style Drift

**User Request:** "Add logging to the upload function"

**❌ Wrong (Reformat Everything)**

```diff
- def upload_file(file_path, destination):
+ def upload_file(file_path: str, destination: str) -> bool:
+     """Upload file to destination with logging."""
      # Changed quote style, added type hints, added docstring,
      # reformatted whitespace, changed boolean return logic
```

**✅ Correct (Match Existing Style)**

```diff
+ import logging
+ logger = logging.getLogger(__name__)
+
  def upload_file(file_path, destination):
+     logger.info(f'Starting upload: {file_path}')
      try:
          # ... existing code unchanged ...
          if response.status_code == 200:
+             logger.info(f'Upload successful: {file_path}')
              return True
```

Matched: Single quotes, no type hints, existing boolean pattern, spacing style.

---

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

### Example: Vague vs. Verifiable

**User Request:** "Fix the authentication system"

**❌ Wrong (Vague Approach)**

```
I'll fix the authentication system by:
1. Reviewing the code
2. Identifying issues
3. Making improvements
4. Testing the changes
```

**✅ Correct (Verifiable Goals)**

```
To "fix authentication," I need success criteria.
What specific issue are we solving?

If the issue is "users stay logged in after password change":

Plan:
1. Write test: Change password → verify old session invalidated
   Verify: Test fails (reproduces bug)

2. Implement: Invalidate sessions on password change
   Verify: Test passes

3. Check edge cases: Multiple active sessions, concurrent changes
   Verify: Additional tests pass

4. Verify no regression: Existing auth tests still pass
   Verify: Full test suite green

What's the specific auth issue you're seeing?
```

### Example: Multi-Step with Verification

**User Request:** "Add rate limiting to the API"

**❌ Wrong (All at Once)**

```python
# Implements full rate limiting with Redis, multiple strategies,
# configuration system, and monitoring in one 300-line commit
```

**✅ Correct (Incremental with Verification)**

```
Plan for rate limiting:

1. Add basic in-memory rate limiting (single endpoint)
   Verify: Test 100 requests → first 10 succeed, rest get 429

2. Extract to middleware (apply to all endpoints)
   Verify: Rate limits apply to /users and /posts

3. Add Redis backend (for multi-server)
   Verify: Rate limit persists across app restarts

4. Add configuration (rates per endpoint)
   Verify: /search allows 10/min, /users allows 100/min

Each step is independently verifiable. Start with step 1?
```

### Example: Test-First Verification

**User Request:** "The sorting breaks when there are duplicate scores"

**❌ Wrong (Fix Without Reproducing)**

```python
# Immediately changes sort logic without confirming the bug
def sort_scores(scores):
    return sorted(scores, key=lambda x: (-x['score'], x['name']))
```

**✅ Correct (Reproduce First)**

```python
# 1. Write a test that reproduces the issue
def test_sort_with_duplicate_scores():
    scores = [
        {'name': 'Alice', 'score': 100},
        {'name': 'Bob', 'score': 100},
        {'name': 'Charlie', 'score': 90},
    ]
    result = sort_scores(scores)
    # Verify: Run test 10 times → fails with inconsistent ordering

# 2. Now fix with stable sort
def sort_scores(scores):
    return sorted(scores, key=lambda x: (-x['score'], x['name']))
    # Verify: Test passes consistently
```

---

## Anti-Patterns Summary

| Principle | Anti-Pattern | Fix |
|-----------|-------------|-----|
| Think Before Coding | Silently assumes file format, fields, scope | List assumptions explicitly, ask for clarification |
| Simplicity First | Strategy pattern for single calculation | One function until complexity is actually needed |
| Surgical Changes | Reformats quotes, adds type hints while fixing bug | Only change lines that fix the reported issue |
| Goal-Driven | "I'll review and improve the code" | "Write test for bug X → make it pass → verify no regressions" |

---

## Key Insight

The "overcomplicated" examples aren't obviously wrong—they follow design patterns and best practices. The problem is **timing**: they add complexity before it's needed, which:

- Makes code harder to understand
- Introduces more bugs
- Takes longer to implement
- Harder to test

**Good code is code that solves today's problem simply, not tomorrow's problem prematurely.**

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
