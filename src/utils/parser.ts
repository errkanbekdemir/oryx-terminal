/**
 * Parses a user-input string into a byte array.
 *
 * Supported formats:
 *   - C-style hex:    0x4F  or  0x1A2B  (multi-byte)
 *   - C-style binary: 0b01001111
 *   - Block hex:      \h(48 69)
 *   - Block decimal:  \d(72 105)
 *   - Block binary:   \b(01001000)
 *   - Block octal:    \o(110 151)
 *   - Escape seqs:    \r  \n  \t  \0  \a  \b  \f  \v  \\  \xFF
 *   - Plain text:     encoded as UTF-8 char codes (charCodeAt)
 */
export const parseInput = (input: string): number[] => {
    const bytes: number[] = [];
    let i = 0;

    while (i < input.length) {
        const char = input[i];

        // C-style 0x... or 0b...
        if (char === '0' && i + 1 < input.length) {
            const next = input[i + 1].toLowerCase();
            if (next === 'x') {
                let end = i + 2;
                while (end < input.length && /[0-9a-fA-F]/.test(input[end])) end++;
                if (end > i + 2) {
                    let cleanHex = input.substring(i + 2, end);
                    if (cleanHex.length % 2 !== 0) cleanHex = '0' + cleanHex;
                    for (let k = 0; k < cleanHex.length; k += 2) {
                        bytes.push(parseInt(cleanHex.substring(k, k + 2), 16));
                    }
                    i = end;
                    continue;
                }
            } else if (next === 'b') {
                let end = i + 2;
                while (end < input.length && /[01]/.test(input[end])) end++;
                if (end > i + 2) {
                    const binStr = input.substring(i + 2, end);
                    const val = parseInt(binStr, 2);
                    if (val <= 255) {
                        bytes.push(val);
                    } else {
                        const needed = Math.ceil(binStr.length / 8) * 8;
                        const padded = binStr.padStart(needed, '0');
                        for (let k = 0; k < padded.length; k += 8) {
                            bytes.push(parseInt(padded.substring(k, k + 8), 2));
                        }
                    }
                    i = end;
                    continue;
                }
            }
        }

        if (char === '\\') {
            const next = input[i + 1];

            // Block parsers: \h(...) \b(...) \d(...) \o(...)
            if (['h', 'b', 'd', 'o'].includes(next) && input[i + 2] === '(') {
                const end = input.indexOf(')', i + 3);
                if (end !== -1) {
                    const content = input.substring(i + 3, end);
                    const tokens = content.split(/[\s,]+/);
                    tokens.forEach(t => {
                        if (!t) return;
                        let val = 0;
                        if (next === 'h') val = parseInt(t, 16);
                        else if (next === 'b') val = parseInt(t, 2);
                        else if (next === 'd') val = parseInt(t, 10);
                        else if (next === 'o') val = parseInt(t, 8);
                        if (!isNaN(val)) bytes.push(val & 0xFF);
                    });
                    i = end + 1;
                    continue;
                }
            }

            // Standard C escape sequences
            if (next === '0') { bytes.push(0);  i += 2; continue; } // Null
            if (next === 'a') { bytes.push(7);  i += 2; continue; } // Bell
            if (next === 'b') { bytes.push(8);  i += 2; continue; } // Backspace
            if (next === 'f') { bytes.push(12); i += 2; continue; } // Form feed
            if (next === 'v') { bytes.push(11); i += 2; continue; } // Vertical tab
            if (next === 'r') { bytes.push(13); i += 2; continue; }
            if (next === 'n') { bytes.push(10); i += 2; continue; }
            if (next === 't') { bytes.push(9);  i += 2; continue; }
            if (next === '\\') { bytes.push(92); i += 2; continue; }
            // Hex escape: \xFF
            if (next === 'x') {
                const hex = input.substring(i + 2, i + 4);
                if (hex.length === 2 && /^[0-9a-fA-F]+$/.test(hex)) {
                    bytes.push(parseInt(hex, 16));
                    i += 4;
                    continue;
                }
            }
        }

        // Plain character — encode as actual UTF-8 bytes, not the raw UTF-16
        // code unit (which is only correct for ASCII and mangles anything
        // else, e.g. ₺, é, ş). Merge surrogate pairs into one codepoint first
        // so characters outside the BMP encode correctly too.
        const codePoint = input.codePointAt(i) ?? char.charCodeAt(0);
        const fullChar = String.fromCodePoint(codePoint);
        for (const b of new TextEncoder().encode(fullChar)) {
            bytes.push(b);
        }
        i += fullChar.length;
    }

    return bytes;
};
