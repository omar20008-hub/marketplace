"use client";

import { useEffect } from "react";

/**
 * The last resort: a failure in the root layout itself.
 *
 * At this point the layout is gone, so this replaces the whole document —
 * which is why it renders its own html and body, and why it cannot use the
 * design system. Those components live under a layout that, by definition, did
 * not render. The styles below are inline for the same reason: the stylesheet
 * is attached by the layout that just failed.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
          background: "#ffffff",
          color: "#1a1a1a",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
        }}
      >
        <div style={{ maxWidth: "32rem" }}>
          <h1 style={{ fontSize: "1rem", fontWeight: 500, margin: 0 }}>
            Builder could not start
          </h1>
          <p
            style={{
              fontSize: "0.85rem",
              lineHeight: 1.6,
              color: "#555555",
              marginTop: "0.5rem",
            }}
          >
            This is a failure in the application shell rather than in one page,
            so there is nothing on this screen to go back to. Reloading is safe.
          </p>

          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: "1rem",
              height: "2.25rem",
              padding: "0 1.1rem",
              borderRadius: "9999px",
              border: "none",
              background: "#1a1a1a",
              color: "#ffffff",
              fontSize: "0.85rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Reload
          </button>

          {error.digest ? (
            <p
              style={{
                marginTop: "1.25rem",
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
                fontSize: "0.72rem",
                color: "#777777",
              }}
            >
              reference {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
