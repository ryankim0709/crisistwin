// PLACEHOLDER: the phone mirror (GET incidents/{id}/participants/{pid}/phone-view) is built by another
// agent, who replaces this file. Keep the props: { incidentId, participantId }.
import { EmptyState } from "../ui";

export default function PhoneMirror({ incidentId, participantId }: { incidentId: string; participantId: string }) {
  return (
    <div className="aix-phone" data-incident={incidentId} data-participant={participantId}>
      <div className="aix-phone-screen">
        <EmptyState title="Phone view coming soon">Their screen will show here.</EmptyState>
      </div>
    </div>
  );
}
