import { useCallback, useEffect, useState } from "react";
import { Button, Field, LoadingState, Notice, Panel, Tag } from "../ui";
import {
  IntelRequestError,
  listFeeds,
  pollFeed,
  type FeedName,
  type FeedStatus,
} from "./api";

/** Butte County; the planner edits it for another area. West, south, east, north. */
const DEFAULT_BBOX = "-122.1, 39.3, -121.0, 40.2";

const message = (cause: unknown) =>
  cause instanceof IntelRequestError ? cause.detail : "The intel service request failed.";
const utc = (value: string | null) => (value ? value.replace("T", " ").replace(/:\d\dZ$/, "Z") : "never");

function parseBbox(text: string): number[] | null {
  const parts = text.split(",").map((part) => Number(part.trim()));
  return parts.length === 4 && parts.every(Number.isFinite) ? parts : null;
}

/** Open live feeds (NWS, Caltrans, WFIGS): last poll, status, counts, and a Poll now button. */
export default function FeedsPanel({ incident, onPolled }: { incident: string; onPolled: () => void }) {
  const [feeds, setFeeds] = useState<FeedStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [bboxText, setBboxText] = useState(DEFAULT_BBOX);
  const [busy, setBusy] = useState<FeedName | null>(null);
  const [note, setNote] = useState<{ tone: "success" | "danger"; text: string } | null>(null);

  const load = useCallback(
    (signal?: AbortSignal) =>
      listFeeds(incident, signal)
        .then((rows) => {
          setFeeds(rows);
          setLoadError(null);
        })
        .catch((cause) => !signal?.aborted && setLoadError(message(cause))),
    [incident],
  );

  useEffect(() => {
    if (!incident) return;
    const controller = new AbortController();
    setFeeds(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [incident, load]);

  const poll = async (feed: FeedStatus) => {
    const bbox = parseBbox(bboxText);
    if (!bbox) {
      setNote({ tone: "danger", text: "Area must be west, south, east, north in degrees." });
      return;
    }
    setBusy(feed.feed);
    setNote(null);
    try {
      const result = await pollFeed(feed.feed, { incident, bbox });
      setNote({
        tone: "success",
        text: `${feed.label}: ${result.candidates} found, ${result.created} new, ${result.updated} updated.`,
      });
      onPolled();
    } catch (cause) {
      setNote({ tone: "danger", text: message(cause) });
    } finally {
      setBusy(null);
      void load();
    }
  };

  return (
    <Panel title="Feeds" eyebrow="Open data">
      <Field label="Area (west, south, east, north)">
        <input value={bboxText} onChange={(e) => setBboxText(e.target.value)} />
      </Field>
      {note && <Notice tone={note.tone} compact>{note.text}</Notice>}
      {loadError ? (
        <Notice tone="danger">{loadError}</Notice>
      ) : feeds === null ? (
        <LoadingState>Loading feeds…</LoadingState>
      ) : (
        <ul className="intel-list" aria-label="Open feeds">
          {feeds.map((feed) => (
            <li className="intel-item" key={feed.feed}>
              <div className="intel-tags">
                <h3>{feed.label}</h3>
                <Tag tone={feed.status === "ok" ? "success" : feed.status === "error" ? "danger" : "neutral"}>
                  {feed.status === "never" ? "Not polled" : feed.status === "ok" ? "OK" : "Failed"}
                </Tag>
              </div>
              <p className="intel-meta">
                Last poll {utc(feed.last_poll_at)} · {feed.counts.unconfirmed} unconfirmed ·{" "}
                {feed.counts.confirmed} confirmed · {feed.counts.rejected} rejected
              </p>
              {feed.error && <Notice tone="danger" compact>{feed.error.detail}</Notice>}
              <div className="intel-actions">
                <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => poll(feed)}>
                  {busy === feed.feed ? "Polling…" : "Poll now"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
