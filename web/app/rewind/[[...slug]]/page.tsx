// Route segments exist so every view has a real, prefetchable URL; rendering happens in the layout.
export function generateStaticParams() {
  return [{ slug: [] }, { slug: ["links"] }, { slug: ["helpdesk"] }, { slug: ["settings", "general"] }];
}

export default function Page() {
  return null;
}
