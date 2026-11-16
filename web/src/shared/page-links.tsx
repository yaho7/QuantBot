import {
  Link as RouterLink,
  NavLink as RouterNavLink,
  useLocation,
  useResolvedPath,
  type LinkProps,
  type NavLinkProps,
} from "react-router-dom";

function usePageTransition(
  to: LinkProps["to"],
  relative: LinkProps["relative"],
) {
  const current = useLocation().pathname.replace(/\/$/, "");
  const next = useResolvedPath(to, { relative }).pathname.replace(/\/$/, "");
  return (
    current !== next && !matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function Link({
  viewTransition,
  ref,
  ...props
}: LinkProps & React.RefAttributes<HTMLAnchorElement>) {
  const animate = usePageTransition(props.to, props.relative);
  return (
    <RouterLink
      {...props}
      ref={ref}
      viewTransition={viewTransition ?? animate}
    />
  );
}

export function NavLink({
  viewTransition,
  ref,
  ...props
}: NavLinkProps & React.RefAttributes<HTMLAnchorElement>) {
  const animate = usePageTransition(props.to, props.relative);
  return (
    <RouterNavLink
      {...props}
      ref={ref}
      viewTransition={viewTransition ?? animate}
    />
  );
}
