import React from "react";

// Demo-resilience: any runtime error in the tree renders a visible message
// instead of a blank page, with a reload affordance.
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("VoltPass runtime error:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="landing">
          <div className="landing-card">
            <div className="brand-big">⚡ VoltPass</div>
            <p className="tagline">Something hit an error — but the demo isn't dead.</p>
            <pre
              style={{
                textAlign: "left",
                whiteSpace: "pre-wrap",
                color: "#f59e0b",
                fontSize: 13,
                background: "#0c1322",
                padding: 12,
                borderRadius: 8,
                maxHeight: 200,
                overflow: "auto",
              }}
            >
              {String(this.state.error?.message ?? this.state.error)}
            </pre>
            <button className="btn primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
