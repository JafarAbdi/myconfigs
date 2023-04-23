import os


if os.environ.get("MPLBACKEND", "") == "module://matplotlib_wezterm":
    import matplotlib
    import matplotlib.pyplot as plt
    import numpy as np

    def display_and_reset(*args):
        plt.show()
        plt.figure()  # New figure for next plot (don't re-use)

    # Tell IPython to display matplotlib figures automatically
    from IPython import get_ipython

    formatter = get_ipython().display_formatter.formatters["text/plain"]
    formatter.for_type(matplotlib.artist.Artist, display_and_reset)
    formatter.for_type(matplotlib.axes.Axes, display_and_reset)
