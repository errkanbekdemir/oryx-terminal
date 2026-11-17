const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s));

const BLOCK_BASES: Record<string, { radix: number; digits: RegExp; name: string }> = {
    h: { radix: 16, digits: /^[0-9a-fA-F]+$/, name: 'hex' },
    b: { radix: 2,  digits: /^[01]+$/,        name: 'binary' },
    d: { radix: 10, digits: /^[0-9]+$/,       name: 'decimal' },
    o: { radix: 8,  digits: /^[0-7]+$/,       name: 'octal' },
};

/** Split a digit string into whole bytes, left-padding the first one. */
const splitBytes = (digits: string, perByte: number, radix: number): number[] => {
    const padded = digits.padStart(Math.ceil(digits.length / perByte) * perByte, '0');
    const out: number[] = [];
    for (let k = 0; k < padded.length; k += perByte) out.push(parseInt(padded.substring(k, k + perByte), radix));
    return out;
};

/**
 * Parses a user-input string into a byte array.
 *
 * Supported formats:
 *   - Block hex:      \h(48 69)  or  \h(4869)
 *   - Block decimal:  \d(72 105)
 *   - Block binary:   \b(01001000)
 *   - Block octal:    \o(110 151)
 *   - Escape seqs:    \r  \n  \t  \0  \a  \b  \f  \v  \\  \xFF
 *   - Plain text:     encoded as UTF-8 ("0x4F" is plain text — use \h(4F))
 *
 * `literal` skips all of the above and sends the text exactly as typed.
 * Throws on a malformed block (\h(ZZ), \d(300), missing ")").
 */
export const parseInput = (input: string, opts: { literal?: boolean } = {}): number[] => {
    if (opts.literal) return utf8(input);

    const bytes: number[] = [];
    let i = 0;

    while (i < input.length) {
        const char = input[i];

        if (char === '\\') {
            const next = input[i + 1];

            // Block parsers: \h(...) \b(...) \d(...) \o(...)
            const base = BLOCK_BASES[next];
            if (base && input[i + 2] === '(') {
                const end = input.indexOf(')', i + 3);
                if (end === -1) throw new Error(`\\${next}( is missing its closing ")"`);
                for (const t of input.substring(i + 3, end).split(/[\s,]+/)) {
                    if (!t) continue;
                    if (!base.digits.test(t)) throw new Error(`"${t}" is not valid ${base.name}`);
                    if (next === 'h') bytes.push(...splitBytes(t, 2, 16));
                    else if (next === 'b') bytes.push(...splitBytes(t, 8, 2));
                    else {
                        const val = parseInt(t, base.radix);
                        if (val > 255) throw new Error(`${base.name} value ${t} does not fit in one byte (max 255)`);
                        bytes.push(val);
                    }
                }
                i = end + 1;
                continue;
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

        // Plain character as UTF-8; merge surrogate pairs into one codepoint
        // first so characters outside the BMP encode correctly too.
        const fullChar = String.fromCodePoint(input.codePointAt(i) ?? char.charCodeAt(0));
        bytes.push(...utf8(fullChar));
        i += fullChar.length;
    }

    return bytes;
};
