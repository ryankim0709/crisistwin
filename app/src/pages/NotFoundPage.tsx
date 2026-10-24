import { LinkButton, Page } from "../ui";

export default function NotFoundPage() {
  return (
    <Page
      eyebrow="Page not found"
      title="This page isn’t here."
      description="Choose a workspace from the sidebar, or start with the fire spread model."
    >
      <LinkButton href="/fire">Open the fire spread model →</LinkButton>
    </Page>
  );
}
