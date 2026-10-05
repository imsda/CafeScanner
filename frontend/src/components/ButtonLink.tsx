import type { ReactNode } from "react";

export function ButtonLink({
  href,
  children,
  className = "",
  ...props
}: {
  href: string;
  children: ReactNode;
  className?: string;
  target?: string;
  rel?: string;
}) {
  return (
    <a href={href} className={`btn ${className}`.trim()} {...props}>
      {children}
    </a>
  );
}
