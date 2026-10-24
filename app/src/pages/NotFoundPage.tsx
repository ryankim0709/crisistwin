import { LinkButton, Page } from "../ui";

export default function NotFoundPage() {
  return (
    <Page title="Page not found">
      <LinkButton href="/fire">Open the fire spread model →</LinkButton>
    </Page>
  );
}
