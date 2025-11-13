class ComponentLoader {
    constructor(config = {}) {
        this.components = new Map();
        this.initialized = false;
        this.config = {
            basePath: config.basePath || '/components',
            defaultExtension: config.defaultExtension || '.html',
            cacheEnabled: config.cacheEnabled !== false,
            enableShadowDOM: config.enableShadowDOM || false,
        };
        this.loadingStates = new Map();
        this.eventHandlers = new Map();
    }

    // Load and cache components
    async loadComponent(componentName) {
        if (this.config.cacheEnabled && this.components.has(componentName)) {
            return this.components.get(componentName);
        }

        if (this.loadingStates.has(componentName)) {
            return this.loadingStates.get(componentName);
        }

        const loadPromise = this._fetchComponent(componentName);
        this.loadingStates.set(componentName, loadPromise);

        try {
            const html = await loadPromise;
            if (this.config.cacheEnabled) {
                this.components.set(componentName, html);
            }
            return html;
        } finally {
            this.loadingStates.delete(componentName);
        }
    }

    async _fetchComponent(componentName) {
        const url = `${this.config.basePath}/${componentName}/${this.config.defaultExtension}`;

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(
                    `HTTP ${response.status}: ${response.statusText}`
                );
            }
            return await response.text();
        } catch (error) {
            console.error(
                `Failed to load ${componentName} from ${url}:`,
                error
            );
            throw error;
        }
    }

    //Template engine with nested object support and XSS protection
    _processTemplate(html, data = {}) {
        if (!data || Object.keys(data).length === 0) return html;

        return html.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
            const trimmedKey = key.trim();
            const value = this._getNestedValue(data, trimmedKey);

            return value !== undefined
                ? this._escapeHtml(String(value))
                : match;
        });
    }

    _getNestedValue(obj, path) {
        return path.split('.').reduce((current, prop) => current?.[prop], obj);
    }

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
