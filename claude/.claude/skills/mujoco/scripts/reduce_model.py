"""Reduce a robot MJCF to a gravity-only model (inertials only)."""

import pathlib

import mujoco

# Element categories removed by the reduction. Everything that does not carry
# mass is stripped; the body tree and explicit inertials remain.
_STRIP_ELEMENTS = (
    "keys",
    "sensors",
    "actuators",
    "tendons",
    "equalities",
    "pairs",
    "excludes",
    "tuples",
    "numerics",
    "texts",
    "skins",
    "flexes",
    "hfields",
    "sites",
    "cameras",
    "lights",
    "geoms",
    "materials",
    "textures",
    "meshes",
    "plugins",
)
_DEFAULT_CLASSES = ("visual", "collision")


def reduced_spec(model_xml_path: pathlib.Path) -> mujoco.MjSpec:
  """Strip a robot MJCF down to its body tree and explicit inertials.

  qfrc_bias at zero velocity (the gravity hold torque) is unchanged, since it
  depends only on configuration, mass, and inertials, none of which are
  touched. Geometry and assets are removed so the result needs no mesh files.
  """
  spec = mujoco.MjSpec.from_file(str(model_xml_path))
  _detach_default_classes(spec)
  _delete_elements(spec)
  _delete_default_classes(spec)
  spec.compiler.meshdir = ""
  spec.compiler.texturedir = ""
  return spec


def reduced_xml(model_xml_path: pathlib.Path) -> str:
  """Reduced model as a self-contained, mesh-free XML string.

  Mesh-free means the string compiles with no .stl files on disk, so it can be
  pickled to other processes (e.g. grain data workers) and rebuilt there.
  """
  spec = reduced_spec(model_xml_path)
  spec.compile()
  return spec.to_xml()


def _detach_default_classes(spec: mujoco.MjSpec) -> None:
  for body in spec.bodies:
    body.childclass = ""
    if body.id != 0:
      body.classname = spec.default
  for joint in spec.joints:
    joint.classname = spec.default


def _delete_elements(spec: mujoco.MjSpec) -> None:
  for element_name in _STRIP_ELEMENTS:
    while elements := getattr(spec, element_name):
      spec.delete(elements[-1])


def _delete_default_classes(spec: mujoco.MjSpec) -> None:
  for class_name in _DEFAULT_CLASSES:
    if default := spec.find_default(class_name):
      spec.delete(default)
