### Code Style

All code follows the principles and guidelines defined in @STYLE.md, this comprehensive style guide covers simplicity, safety (NASA's Power of Ten rules), performance, and developer experience. The following sections describe repository-specific conventions that complement the general style guide.

### Python

All Python code follows @PYTHON.md for modern syntax preferences (3.11+ default).

### No Backward Compatibility Shims

Unless explicitly told to do so, when renaming or refactoring:

- Update ALL usages across the codebase
- Delete the old name/code completely
- NEVER add compatibility aliases like `OldName = NewName`
- NEVER add `# TODO: remove this` comments for deprecated code
- If something is unused after a change, delete it immediately
