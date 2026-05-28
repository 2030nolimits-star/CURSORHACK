import { NextRequest, NextResponse } from "next/server";

// Proxy to the Alpic-hosted MCP server HTTP endpoint
// Set ALPIC_MCP_URL in .env.local once deployed: alpic deploy ./mcp --name intentgraph
const ALPIC_MCP_URL = process.env.ALPIC_MCP_URL;

export async function POST(req: NextRequest) {
  if (!ALPIC_MCP_URL) {
    return NextResponse.json(
      { error: "ALPIC_MCP_URL not configured — deploy the MCP server to Alpic first" },
      { status: 503 }
    );
  }

  const body = await req.text();

  const upstream = await fetch(ALPIC_MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": req.headers.get("Content-Type") ?? "application/json",
      Authorization: `Bearer ${process.env.ALPIC_API_KEY ?? ""}`,
    },
    body,
  });

  const responseBody = await upstream.text();
  return new NextResponse(responseBody, {
    status: upstream.status,
    headers: { "Content-Type": upstream.headers.get("Content-Type") ?? "application/json" },
  });
}
