import { SecurityProvider } from "./SecurityContext";

export default function SecurityLayout({ children }: { children: React.ReactNode }) {
  return <SecurityProvider>{children}</SecurityProvider>;
}
