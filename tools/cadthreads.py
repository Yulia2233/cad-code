"""Bound the geometry kernel's default thread pool.

The kernel sizes its pool from the machine's logical CPU count (112 on the training server although the container only owns ~14 cores);
every process that runs a boolean would then own ~100 threads, and a dozen workers can exhaust the container's process/thread limit
(sshd can no longer fork).  Call limit() once at process start, before any CAD operation.
"""
import os


def limit(n=None):
    n = int(os.environ.get("CAD_THREADS", n if n is not None else 4))
    try:
        from OCP.OSD import OSD_ThreadPool
        OSD_ThreadPool.DefaultPool_s(n)
    except Exception:  # noqa: BLE001
        pass
