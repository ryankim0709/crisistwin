"""Headless batch runner: scenario x strategy x seed, scored with the AAR and compared (simulated).

    python manage.py live_batch --spec api/live/specs/camp-2018-pilot.json \
        --strategies historical_only,rule_auto,record_delay_5 --out /tmp/batch-pilot

Writes ``<out>/manifests.jsonl`` (one ``RunManifest`` per run, appended), ``<out>/comparison.md``
and ``<out>/comparison.json``. ``--compare-only`` re-reads an existing manifests file and only
compares. Writes nothing to MongoDB and needs no running server (``MONGODB_URI`` must still be set
for Django settings). See docs/batch-runner.md and ``api.live.batch``.
"""

import json
import shlex
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from api.live import batch


class Command(BaseCommand):
    help = "Simulated planning experiment: run strategies over a scenario's seed panel headless and compare them."

    def add_arguments(self, parser):
        parser.add_argument("--spec", help="Scenario spec JSON (docs/batch-runner.md).")
        parser.add_argument("--strategies", default="historical_only,rule_auto,record_delay_5",
                            help="Comma list: historical_only, rule_auto, record_delay_<N>, mcp_agent.")
        parser.add_argument("--agent-cmd", help="For mcp_agent: command of an agent speaking the JSON-lines turn protocol.")
        parser.add_argument("--agent-name", default="agent", help="For mcp_agent: strategy id suffix.")
        parser.add_argument("--seeds", type=int, help="Override seeds.n of the spec.")
        parser.add_argument("--panel", choices=("dev", "test"), help="Override seeds.panel of the spec.")
        parser.add_argument("--start", help="Override window.start (UTC ISO).")
        parser.add_argument("--end", help="Override window.end (UTC ISO).")
        parser.add_argument("--baseline", default="historical_only", help="Baseline strategy id for the comparison.")
        parser.add_argument("--n-boot", type=int, default=10_000, help="Bootstrap resamples (default 10,000).")
        parser.add_argument("--workers", type=int, default=1,
                            help="Forked worker processes, one seed block each (POSIX; not with mcp_agent).")
        parser.add_argument("--out", default="live-batch", help="Output directory.")
        parser.add_argument("--compare-only", help="Existing manifests.jsonl: compare without running.")

    def handle(self, *args, **o):
        out = Path(o["out"])
        out.mkdir(parents=True, exist_ok=True)
        if o["compare_only"]:
            manifests = batch.read_manifests(o["compare_only"])
        else:
            if not o["spec"]:
                raise CommandError("--spec is required unless --compare-only is given.")
            raw = json.loads(Path(o["spec"]).read_text())
            if o["seeds"] is not None:
                raw.setdefault("seeds", {})["n"] = o["seeds"]
            if o["panel"]:
                raw.setdefault("seeds", {})["panel"] = o["panel"]
            if o["start"] or o["end"]:
                raw["window"] = {**raw.get("window", {}), **({"start": o["start"]} if o["start"] else {}),
                                 **({"end": o["end"]} if o["end"] else {})}
            try:
                spec = batch.spec_from_dict(raw)
                strategies = []
                for name in [s.strip() for s in o["strategies"].split(",") if s.strip()]:
                    kw = {}
                    if name == "mcp_agent":
                        if not o["agent_cmd"]:
                            raise CommandError("mcp_agent needs --agent-cmd.")
                        kw = {"agent": shlex.split(o["agent_cmd"]), "agent_name": o["agent_name"]}
                    strategies.append(batch.make_strategy(name, **kw))
            except (ValueError, KeyError) as exc:
                raise CommandError(str(exc)) from exc
            world = batch.build_world(spec, self.stderr.write)
            seeds = spec.seed_list(batch._sim()[1])
            manifest_path = out / "manifests.jsonl"
            workers = 1 if any(s.strategy_id.startswith("orchestrator:") for s in strategies) else o["workers"]
            results = batch.run_batch(world, strategies, seeds, manifest_path=manifest_path, workers=workers,
                                      progress=self.stderr.write)
            manifests = [r.manifest for r in results]
            self.stdout.write(f"wrote {len(results)} manifests to {manifest_path}")
        md, js = batch.compare_runs(manifests, o["baseline"], n_boot=o["n_boot"])
        (out / "comparison.md").write_text(md)
        (out / "comparison.json").write_text(json.dumps(js, indent=2) + "\n")
        self.stdout.write(f"wrote {out / 'comparison.md'} and {out / 'comparison.json'}")
