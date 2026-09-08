import { headers } from "next/headers";
import DashboardClient from "./dashboard-client";

export default async function Home() {
  const requestHeaders = await headers();
  const encodedName = requestHeaders.get("oai-authenticated-user-full-name");
  const displayName = encodedName && requestHeaders.get("oai-authenticated-user-full-name-encoding") === "percent-encoded-utf-8"
    ? decodeURIComponent(encodedName)
    : encodedName || "Murphy";
  return <DashboardClient displayName={displayName.split(" ")[0]} />;
}
