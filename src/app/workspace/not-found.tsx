import Link from "next/link";

export default function MissingChange() {
  return (
    <section className="p-8 text-sm">
      <h1>Workspace not found</h1>
      <p className="mt-3 text-muted-foreground">
        This project or thread is unavailable to your account.
      </p>
      <Link className="mt-4 inline-block underline" href="/workspace">
        Back to projects
      </Link>
    </section>
  );
}
