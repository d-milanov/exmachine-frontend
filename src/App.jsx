import { useState } from "react";
import "./App.css";

const MAX_CHARS = 2_000_000;

export default function App() {
  const [text, setText] = useState(`NVIDIA Announces Financial Results for First Quarter Fiscal 2027
Record revenue of $81.6 billion, up 85% from a year ago
Record Data Center revenue of $75.2 billion, up 92% from a year ago
NVIDIA announces $80.0 billion additional share repurchase authorization and increases its quarterly cash dividend from $0.01 per share to $0.25 per share
May 20, 2026
NVIDIA Announces Financial Results for First Quarter Fiscal 2027
NVIDIA (NASDAQ: NVDA) today reported record revenue for the first quarter ended April 26, 2026, of $81.6 billion, up 20% from the previous quarter and up 85% from a year ago.

For the quarter, GAAP and non-GAAP gross margins were 74.9% and 75.0%, respectively.

For the quarter, GAAP and non-GAAP earnings per diluted share were $2.39 and $1.87, respectively.`);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [truncated, setTruncated] = useState(false);

  const handleExtract = async () => {
    const isTooLong = text.length > MAX_CHARS;
    const payload = isTooLong ? text.slice(0, MAX_CHARS) : text;
    setTruncated(isTooLong);
    setError(null);
    setResult(null);
    setLoading(true);

    try {
      const apiBase = import.meta.env.VITE_API_BASE ?? "";
      const url = `${apiBase}/extractions`
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: payload }),
      });
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json();
      setResult({ ...data, inputText: payload });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const getSource = (inputText, start, length) => {
//   console.log( `source: ${JSON.stringify({start, length})}`)
   if(start > 0) start--
   return inputText.slice(start, start + length);
  };

  return (
    <div className="page">
      <header className="header">
        <span className="header-label">Extraction Machine</span>
        <span className="header-sub">Numbers · Percentage · Money · Dates · Periods · Earnings · Revenue</span>
      </header>

      <main className="main">
        <div className="input-block">
          <label className="field-label" htmlFor="input-text">
            Input Text
            <span className="char-count">{text.length.toLocaleString()} chars</span>
          </label>
          <textarea
            id="input-text"
            className="textarea"
            placeholder="Paste or type your text here…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />
          <div className="action-row">
            <button
              className={`btn-extract${loading ? " btn-loading" : ""}`}
              onClick={handleExtract}
              disabled={loading || text.trim().length === 0}
            >
              {loading ? <span className="spinner" /> : null}
              {loading ? "Extracting…" : "Extract"}
            </button>
            {truncated && (
              <span className="warning">
                Text is too long. Only first 2 million characters are analyzed.
              </span>
            )}
          </div>
        </div>

        {error && <div className="error-box">⚠ {error}</div>}

        {result && (
          <div className="result-block">
            <div className="time-row">
              <span className="time-label">Extraction time</span>
              <span className="time-value">{result.time} ms</span>
            </div>

            {result.extractions && result.extractions.length > 0 ? (
              <div className="table-wrap">
                <table className="result-table">
                  <thead>
                    <tr>
                      <th>Value</th>
                      <th>Type</th>
                      <th>Source</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.extractions.map((row, i) => (
                      <tr key={i} className={`type-${row.type?.toLowerCase()}`}>
                        <td className="td-value">{row.value}</td>
                        <td className="td-type">
                          <span className={`badge badge-${row.type?.toLowerCase()}`}>
                            {row.type}
                          </span>
                        </td>
                        <td className="td-source">
                          {getSource(result.inputText, row.start, row.length)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="empty">No extractions found.</p>
            )}
          </div>
        )}
      </main>
      <div className="footer-container">
        <footer>
          2026&nbsp;&nbsp;
          <a href="mailto:danila.milanov@gmail.com">
            Danila Milanov
         </a>
        </footer>
      </div>  
    </div>
  );
}
