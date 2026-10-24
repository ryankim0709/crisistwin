import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { Button, Field, Notice } from "../ui";
import { buildJoinLink, checkServerOrigin } from "./joinLink";
import "./invite.css";

/**
 * "Invite phones": the join link and its QR code (ADR 0034). The invite code is typed here;
 * nothing secret is fetched. The server defaults to this page's origin, which a phone can only
 * use when it is a `.local` name or an HTTPS tunnel, so the field is editable.
 */
export default function InvitePhones({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [server, setServer] = useState(() => window.location.origin);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);
  const check = useMemo(() => checkServerOrigin(server), [server]);
  const link = check.ok ? buildJoinLink(check.origin, code) : null;
  const svg = useMemo(() => {
    if (!link) return null;
    const qr = qrcode(0, "M");
    qr.addData(link);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [link]);
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <dialog ref={dialog} className="lc-invite" aria-labelledby="lc-invite-title" onClose={onClose}>
      <h2 id="lc-invite-title">Invite phones</h2>
      <Field label="Server address" hint="This computer's .local name on the same Wi-Fi, or your HTTPS tunnel.">
        <input
          value={server}
          onChange={(e) => setServer(e.target.value)}
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field label="Responder invite code" hint="Optional. Leave empty to join as a civilian.">
        <input value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" spellCheck={false} />
      </Field>
      {check.ok ? (
        <>
          <div
            className="lc-invite-qr"
            role="img"
            aria-label="QR code of the join link"
            dangerouslySetInnerHTML={{ __html: svg ?? "" }}
          />
          <code className="lc-invite-link">{link}</code>
          {code.trim() ? (
            <p className="lc-dim">This QR code contains the invite code. Show it only to responders.</p>
          ) : null}
        </>
      ) : (
        <Notice tone="warning" compact>
          {check.reason}
        </Notice>
      )}
      <div className="lc-invite-actions">
        <Button variant="secondary" disabled={!link} onClick={() => void copy()}>
          {copied ? "Copied" : "Copy link"}
        </Button>
        <Button variant="secondary" onClick={() => dialog.current?.close()}>
          Close
        </Button>
      </div>
    </dialog>
  );
}
