#!/usr/bin/env python3
"""pybind11-stubgen driver that resolves raw C++ type names in signatures.

pybind11 bindings often leak unqualified C++ type names into docstrings, e.g.
`mujoco::python::MjModelJointViews`, which stubgen can't parse and renders as
`...`. This maps such names back to the real python class by indexing every
class in the target package: an unresolved `<ns>::...::<Leaf>` becomes the class
named `<Leaf>` or `_<Leaf>`, when exactly one such class exists (ambiguous or
missing names are left untouched, so it never resolves wrongly).

Uses pybind11-stubgen's `parse_annotation_str` extension point. CLI is identical
to `pybind11-stubgen`.
"""
import importlib
import inspect
import logging
import pkgutil
import re
import sys

from pybind11_stubgen import (
    CLIArgs,
    Printer,
    Writer,
    arg_parser,
    run,
    stub_parser_from_args,
    to_output_and_subdir,
)
from pybind11_stubgen.parser.interface import IParser
from pybind11_stubgen.structs import InvalidExpression, QualifiedName, ResolvedType

_CXX_NAME = re.compile(r"^[\w:]+::(\w+)$")


def build_class_index(root_name: str) -> dict[str, set[str]]:
    """Map simple class name -> {canonical fully-qualified name} for the package.

    Best-effort imports submodules (skipping ones whose import fails, e.g.
    optional GL backends), then indexes classes from every loaded package module.
    """
    root = importlib.import_module(root_name)
    prefix = root_name + "."
    for info in pkgutil.walk_packages(
        getattr(root, "__path__", []), prefix, onerror=lambda _name: None
    ):
        try:
            importlib.import_module(info.name)
        except Exception:
            pass
    index: dict[str, set[str]] = {}
    for name, module in list(sys.modules.items()):
        if module is None or (name != root_name and not name.startswith(prefix)):
            continue
        try:
            members = inspect.getmembers(module, inspect.isclass)
        except Exception:
            continue
        for _, obj in members:
            mod = getattr(obj, "__module__", "") or ""
            if mod == root_name or mod.startswith(prefix):
                index.setdefault(obj.__name__, set()).add(f"{mod}.{obj.__qualname__}")
    return index


def make_resolver(index: dict[str, set[str]]):
    class ResolveCxxNames(IParser):
        def parse_annotation_str(self, annotation_str: str):
            result = super().parse_annotation_str(annotation_str)
            if isinstance(result, InvalidExpression):
                m = _CXX_NAME.match(annotation_str.strip())
                if m:
                    leaf = m.group(1)
                    hits = index.get(leaf, set()) | index.get("_" + leaf, set())
                    if len(hits) == 1:
                        return ResolvedType(QualifiedName.from_str(next(iter(hits))))
            return result

    return ResolveCxxNames


def main() -> None:
    logging.basicConfig(
        level=logging.WARNING, format="%(name)s - [%(levelname)7s] %(message)s"
    )
    # pybind11-stubgen logs every raw C++ expression as an ERROR while parsing,
    # before the resolver below replaces it in the output. The logs are stale
    # noise; silence them (the produced stub is what matters).
    logging.getLogger("pybind11_stubgen").setLevel(logging.CRITICAL)
    args = arg_parser().parse_args(namespace=CLIArgs())
    index = build_class_index(args.module_name.split(".")[0])
    base_parser = stub_parser_from_args(args)

    class Parser(make_resolver(index), type(base_parser)):
        pass

    printer = Printer(invalid_expr_as_ellipses=not args.print_invalid_expressions_as_is)
    out_dir, sub_dir = to_output_and_subdir(
        output_dir=args.output_dir,
        module_name=args.module_name,
        root_suffix=args.root_suffix,
    )
    run(
        Parser(),
        printer,
        args.module_name,
        out_dir,
        sub_dir=sub_dir,
        dry_run=args.dry_run,
        writer=Writer(stub_ext=args.stub_extension),
    )


if __name__ == "__main__":
    main()
