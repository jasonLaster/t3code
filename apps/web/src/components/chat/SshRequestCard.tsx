import { pipe } from "effect/Function";
import { useAtomValue } from "@effect/atom-react";
import {
  linkRequestAnswerInput,
  linkRequestFailureMessage,
  type LinkRequestItem,
  sshRequestAnswerInput,
  sshRequestDesktopTarget,
  sshRequestTargetLabel,
} from "@t3tools/client-runtime/link-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";
import { useRef, useState } from "react";

import { connectSshEnvironment as connectSshEnvironmentAtom } from "~/connection/onboarding";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatDesktopSshConnectionError } from "../settings/ConnectionsSettings.logic";
import { Button } from "../ui/button";

/**
 * Inline card for an SSH host an agent asked the user to connect. Connecting
 * runs the desktop app's own SSH flow, with the user's SSH config, keys and
 * password prompt; the card then reports only the environment it saved.
 */
export function PendingSshRequest(props: {
  readonly environmentId: EnvironmentId;
  readonly item: LinkRequestItem & { readonly ssh: NonNullable<LinkRequestItem["ssh"]> };
}) {
  const { item } = props;
  const gt = useGT();
  const messages = useMessages();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter then a click can both run before a re-render; this guard is synchronous.
  const inFlight = useRef(false);
  const answer = useAtomCommand(peerLinkEnvironment.answerRequest, {
    label: "answer SSH environment request",
    reportFailure: false,
    reportDefect: false,
  });
  const connect = useAtomCommand(connectSshEnvironmentAtom, { reportFailure: false });
  const canAnswer = useAtomValue(
    peerLinkEnvironment.answerRequest.permissionAtom(props.environmentId),
  );
  // Only the desktop app can open an SSH tunnel.
  const canConnect = window.desktopBridge !== undefined;
  const target = sshRequestTargetLabel(item.ssh);

  const run = async (work: () => Promise<string | null>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const failure = await work();
    inFlight.current = false;
    setBusy(false);
    if (failure !== null) setError(failure);
  };

  const sendAnswer = async (input: ReturnType<typeof linkRequestAnswerInput>) => {
    if (input === null) return null;
    const result = await answer({ environmentId: props.environmentId, input });
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
    return pipe(squashAtomCommandFailure(result), (failure) =>
      linkRequestFailureMessage(failure, messages),
    );
  };

  const decline = () => run(() => sendAnswer(linkRequestAnswerInput(item, { type: "decline" })));

  const connectHost = () =>
    run(async () => {
      const connected = await connect({ target: sshRequestDesktopTarget(item.ssh), label: "" });
      if (connected._tag === "Failure") {
        return isAtomCommandInterrupted(connected)
          ? null
          : formatDesktopSshConnectionError(squashAtomCommandFailure(connected));
      }
      // The card switches to its answered row once the item updates.
      return sendAnswer(
        sshRequestAnswerInput(item, { environmentId: connected.value, label: item.ssh.host }),
      );
    });

  return (
    <div
      data-v2-item-type={item.type}
      data-ssh-request
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-medium text-foreground">
          {gt("Connect {target} over SSH", { target })}
        </p>
        {item.reason.trim() ? <p className="text-sm text-muted-foreground">{item.reason}</p> : null}
        <p className="text-xs text-muted-foreground">
          <T>This app signs in with your SSH config and keys, then adds the host to Connections.</T>
        </p>
      </div>
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {canAnswer ? (
        <div className="flex min-w-0 items-center justify-end gap-2">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            disabled={busy}
            onClick={() => void decline()}
          >
            <T>Decline</T>
          </Button>
          {canConnect ? (
            <Button type="button" size="xs" disabled={busy} onClick={() => void connectHost()}>
              {busy ? gt("Connecting…") : gt("Connect", { $context: "verb, connect over SSH" })}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          <T>Only a session that manages access here can answer this.</T>
        </p>
      )}
      {canAnswer && !canConnect ? (
        <p className="text-xs text-muted-foreground">
          <T>Open this thread in the T3 Code desktop app to connect over SSH.</T>
        </p>
      ) : null}
    </div>
  );
}
