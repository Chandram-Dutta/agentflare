import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import {
  resolveRepositoryLink,
  type RepositoryFileLink,
} from "@/lib/repository-links";

export type RepositoryLinkProps = {
  threadId?: string;
  onOpenFile?: (file: RepositoryFileLink) => void;
};

export function ChatMarkdown({
  children,
  threadId,
  onOpenFile,
}: { children: string } & RepositoryLinkProps) {
  return (
    <div className="min-w-0 break-words leading-5 [&>*+*]:mt-3 [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:font-semibold [&_li+li]:mt-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5 [&_pre]:overflow-x-auto [&_pre]:border [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_th]:border [&_th]:px-2 [&_th]:py-1 [&_td]:border [&_td]:px-2 [&_td]:py-1">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={{
          img: ({ src, alt, title, width, height }) => (
            // Agent output may point to any image host, not a Next image allowlist.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={src}
              alt={alt ?? ""}
              title={title}
              width={width}
              height={height}
              loading="lazy"
              referrerPolicy="no-referrer"
              className="h-auto max-w-full"
            />
          ),
          a: ({ href, children, title }) => {
            const file =
              threadId && onOpenFile
                ? resolveRepositoryLink(href, threadId)
                : null;
            return (
              <a
                href={href}
                title={title}
                target={file ? undefined : "_blank"}
                rel="noopener noreferrer"
                onClick={(event) => {
                  if (!threadId || !onOpenFile) return;
                  const target =
                    file ??
                    resolveRepositoryLink(
                      href,
                      threadId,
                      window.location.origin,
                    );
                  if (!target) return;
                  event.preventDefault();
                  onOpenFile(target);
                }}
              >
                {children}
              </a>
            );
          },
          table: ({ children }) => (
            <div className="overflow-x-auto">
              <table className="border-collapse text-left">{children}</table>
            </div>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
