import { Editor } from "obsidian";
import { Base64File } from "./conversion";

export interface ReferenceLink {
    inlineRef: string;  // ![alt][ref_id]
    definition: string; // [ref_id]: data:image/...
    refId: string;
}

export class ReferenceLinksManager {
    private counter: number = 0;

    /**
     * Generate unique reference ID based on style preference
     */
    generateRefId(filename: string, style: 'filename' | 'timestamp' | 'counter'): string {
        switch (style) {
            case 'filename':
                // Remove extension and sanitize
                const baseName = filename.replace(/\.[^/.]+$/, '');
                const sanitized = baseName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
                return `img_${sanitized}`;
            case 'timestamp':
                return `img_${Date.now()}`;
            case 'counter':
                this.counter++;
                return `img_${this.counter}`;
            default:
                return `img_${Date.now()}`;
        }
    }

    /**
     * Create inline reference and definition for a base64 image
     */
    createReferenceLink(
        base64File: Base64File,
        style: 'filename' | 'timestamp' | 'counter'
    ): ReferenceLink {
        const refId = this.generateRefId(base64File.filename, style);
        const base64Data = base64File.to64Data();
        
        return {
            inlineRef: `![${base64File.filename}][${refId}]`,
            definition: `[${refId}]: ${base64Data}`,
            refId: refId
        };
    }

    /**
     * Parse existing reference definitions from document content
     */
    parseExistingReferences(content: string): Map<string, string> {
        const references = new Map<string, string>();
        // Match reference definitions: [ref_id]: data:image/...
        const regex = /^\[([^\]]+)\]:\s*(data:image\/[^\s]+)/gm;
        let match;
        
        while ((match = regex.exec(content)) !== null) {
            references.set(match[1], match[2]);
        }
        
        return references;
    }

    /**
     * Find the position to insert reference definitions
     * Returns the line number where definitions should be inserted
     */
    findDefinitionInsertPosition(editor: Editor): number {
        const content = editor.getValue();
        const lines = content.split('\n');
        
        // Look for existing reference definitions at the end
        let insertLine = lines.length;
        
        // Find the last non-empty line that's not a reference definition
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i].trim();
            if (line === '') continue;
            
            // Check if line is a reference definition
            if (line.match(/^\[[^\]]+\]:\s*data:image\//)) {
                // This is a reference definition, continue searching up
                continue;
            } else {
                // Found a content line, insert after this
                insertLine = i + 1;
                break;
            }
        }
        
        return insertLine;
    }

    /**
     * Insert definition at the end of document (before any existing definitions)
     */
    insertDefinition(editor: Editor, definition: string): void {
        const insertLine = this.findDefinitionInsertPosition(editor);
        const content = editor.getValue();
        const lines = content.split('\n');
        
        // Check if we need to add spacing before the definition
        let prefix = '';
        if (insertLine > 0 && lines[insertLine - 1]?.trim() !== '') {
            prefix = '\n\n';
        } else if (insertLine > 0 && lines[insertLine - 1]?.trim() === '') {
            prefix = '\n';
        }
        
        // Insert at the calculated position
        const pos = editor.posToOffset({ line: insertLine, ch: 0 });
        editor.replaceRange(prefix + definition + '\n', editor.offsetToPos(pos));
    }

    /**
     * Create multiple reference links and their definitions
     */
    createMultipleReferenceLinks(
        base64Files: Base64File[],
        style: 'filename' | 'timestamp' | 'counter'
    ): { inlineRefs: string[]; definitions: string[] } {
        const inlineRefs: string[] = [];
        const definitions: string[] = [];
        
        for (const file of base64Files) {
            const ref = this.createReferenceLink(file, style);
            inlineRefs.push(ref.inlineRef);
            definitions.push(ref.definition);
        }
        
        return { inlineRefs, definitions };
    }
}

// Export singleton instance
export const referenceLinksManager = new ReferenceLinksManager();
