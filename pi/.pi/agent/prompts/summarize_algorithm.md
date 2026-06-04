---
description: Refactor and summarize a Python algorithm
argument-hint: "<ALGORITHM_NAME>"
---
You will be refactoring and summarizing a Python algorithm to make it cleaner, more maintainable, and aligned with modern best practices while preserving all original functionality.

Here is the name of the algorithm:
<algorithm_name>
$1
</algorithm_name>

Here is the current code is in the current directory.

Your task is to refactor this code according to the following requirements:

1. **Preserve all functionality** - Every feature, edge case, and behavior from the original code must be maintained exactly. Do not remove or alter any functionality.

2. **Use modern Python best practices** - Apply current Python conventions including:
   - Type hints for function parameters and return values
   - f-strings for string formatting
   - Context managers (with statements) where appropriate
   - List/dict comprehensions where they improve readability
   - Pathlib for file operations if applicable
   - Dataclasses or named tuples for structured data if appropriate

3. **Apply separation of concerns** - Organize code into logical sections:
   - Break down large functions into smaller, focused functions
   - Group related functionality together
   - Use classes if the code would benefit from encapsulation
   - Separate configuration, logic, and I/O concerns

4. **Follow KISS principle (Keep It Simple, Stupid)** - Simplify complex logic where possible:
   - Remove unnecessary complexity
   - Eliminate redundant code
   - Use clearer, more direct approaches
   - But never sacrifice functionality for simplicity

5. **Ensure clean and maintainable code**:
   - Use descriptive, clear variable and function names
   - Add docstrings to functions and classes
   - Include inline comments only where logic is non-obvious
   - Maintain consistent formatting and style
   - Keep functions focused on a single responsibility

Before providing your refactored code, use the scratchpad to:

1. Analyze the current code structure and identify all functionality
2. Note any issues or areas for improvement
3. Plan your refactoring approach
4. Identify which modern Python features would be beneficial

After your analysis, write the consolidated Python file. Include a brief comment at the top of the file explaining its purpose. Then, provide a summary of the changes you made, explaining:

- What improvements were made
- Which modern Python features were applied
- How the code structure was improved
- Confirmation that all original functionality was preserved
