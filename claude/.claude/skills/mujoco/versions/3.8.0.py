# /// script
# dependencies = ["mujoco==3.11.0"]
# ///
"""New in mujoco 3.8.0 (April 24, 2026)."""

import mujoco

# A cylinder resting on a box on the floor: a convex-convex pair that produces a
# contact manifold rather than a single point.
STACK_XML = """
<mujoco model="stack">
  <option timestep="0.002"/>
  <worldbody>
    <geom name="floor" type="plane" size="5 5 0.1"/>
    <body name="crate" pos="0 0 0.1">
      <freejoint/>
      <geom name="crate" type="box" size="0.15 0.15 0.1" mass="4"/>
    </body>
    <body name="drum" pos="0 0 0.3">
      <freejoint/>
      <geom name="drum" type="cylinder" size="0.12 0.1" mass="2"/>
    </body>
  </worldbody>
</mujoco>
"""

SETTLE_STEPS = 600


def settle(model: mujoco.MjModel) -> mujoco.MjData:
    """Step until the stack comes to rest, so contact counts are the steady-state ones."""
    data = mujoco.MjData(model)
    mujoco.mj_step(model, data, nstep=SETTLE_STEPS)
    return data


def max_contacts_per_pair() -> None:
    """Ask the collider how many contacts a geom pair can ever produce, without simulating."""
    model = mujoco.MjModel.from_xml_string(STACK_XML)
    pairs = (("drum", "crate"), ("crate", "floor"), ("drum", "floor"))

    # mj_maxContact queries the collision pipeline directly, so contact budgets no
    # longer have to be guessed from geom types by hand. has_margin=-1 reads each
    # geom's margin from the model; pass >0 to ask what a margin would cost.
    budget = {
        pair: mujoco.mj_maxContact(model, model.geom(pair[0]).id, model.geom(pair[1]).id, -1)
        for pair in pairs
    }

    data = settle(model)
    observed: dict[tuple[str, str], int] = dict.fromkeys(pairs, 0)
    for contact in data.contact[: data.ncon]:
        names = (model.geom(contact.geom[0]).name, model.geom(contact.geom[1]).name)
        key = names if names in observed else names[::-1]
        observed[key] += 1

    lines = ", ".join(f"{a}-{b}: {observed[a, b]}/{budget[a, b]}" for a, b in pairs)
    print(f"max_contacts_per_pair: observed/max {lines}; "
          f"worst-case total={sum(budget.values())}, actual ncon={data.ncon}")


def multiccd_by_default() -> None:
    """Recover the pre-3.8.0 single-point convex collisions by disabling multiccd."""
    model = mujoco.MjModel.from_xml_string(STACK_XML)

    def convex_contacts(data: mujoco.MjData) -> int:
        """Count contacts on the drum-crate pair, the only convex-convex pair here."""
        floor_id = model.geom("floor").id
        return sum(1 for contact in data.contact[: data.ncon] if floor_id not in contact.geom)

    data_multi = settle(model)

    # multiccd (multiple contact points from convex collision detection) is on by
    # default since 3.8.0; it used to be an opt-in enable flag, so this disable
    # flag is the migration path back to the legacy single-point behaviour.
    model.opt.disableflags |= mujoco.mjtDisableBit.mjDSBL_MULTICCD
    data_single = settle(model)

    print(f"multiccd_by_default: drum-crate contacts default={convex_contacts(data_multi)}, "
          f"multiccd disabled={convex_contacts(data_single)}; "
          f"total ncon {data_multi.ncon} vs {data_single.ncon} "
          f"(plane collisions are unaffected)")


def main() -> None:
    max_contacts_per_pair()
    multiccd_by_default()


if __name__ == "__main__":
    main()
