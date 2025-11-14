class ComponentLoader {
    constructor(config = {}) {
        this.components = new Map();
        this.initialized = false;
        this.config = {
            basePath: config.basePath || '/components',
            defaultExtension: config.defaultExtension || '.html',
            cacheEnabled: config.cacheEnabled !== false,
            enableShadowDOM: config.enableShadowDOM || false,
            executeScripts: config.executeScripts !== false,
        };
        this.loadingStates = new Map();
        this.eventHandlers = new Map();
        this.injectionLocks = new Map(); // Prevent concurrent injections to same target
    }

    // Load and cache components with duplicate request prevention
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
        const url = `${this.config.basePath}/${componentName}${this.config.defaultExtension}`;

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
                `Failed to load component "${componentName}" from ${url}:`,
                error
            );
            throw error;
        }
    }

    // Enhanced template engine with nested object support and XSS protection
    _processTemplate(html, data = {}) {
        if (!data || Object.keys(data).length === 0) return html;

        return html.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
            const trimmedKey = key.trim();
            const value = this._getNestedValue(data, trimmedKey);

            // XSS protection: escape HTML by default
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

    // Resolve target to DOM element - accepts element, selector, or ID string
    _resolveTarget(target) {
        if (target instanceof Element) {
            return target;
        }

        if (typeof target === 'string') {
            let element = document.querySelector(target);

            if (
                !element &&
                !target.includes(' ') &&
                !target.startsWith('.') &&
                !target.startsWith('[')
            ) {
                element = document.getElementById(target);
            }

            return element;
        }

        return null;
    }

    // Generate unique key for tracking component instances
    _getInstanceKey(componentName, targetElement) {
        // Use element reference if available, fallback to ID
        const targetId =
            targetElement.id ||
            `_anonymous_${this._getElementPath(targetElement)}`;
        return `${componentName}:${targetId}`;
    }

    _getElementPath(element) {
        const path = [];
        let current = element;
        while (current && current !== document.body) {
            const index = Array.from(
                current.parentNode?.children || []
            ).indexOf(current);
            path.unshift(index);
            current = current.parentNode;
        }
        return path.join('-');
    }

    // Inject component with concurrency control and improved options
    async injectComponent(componentName, target, options = {}) {
        const {
            data = {},
            append = false,
            shadow = false,
            transition = null,
            preserveFocus = true,
            executeScripts = this.config.executeScripts,
        } = options;

        const targetElement = this._resolveTarget(target);

        if (!targetElement) {
            throw new Error(`Target element not found: ${target}`);
        }

        // Acquire lock for this target to prevent concurrent modifications
        const lockKey = this._getInstanceKey(componentName, targetElement);
        await this._acquireLock(lockKey);

        try {
            // Save focus state
            const focusedElement = preserveFocus
                ? document.activeElement
                : null;
            const focusWasInTarget =
                preserveFocus && targetElement.contains(focusedElement);

            const html = await this.loadComponent(componentName);

            // Clean up existing event listeners if replacing content
            if (!append) {
                this._cleanupEventListeners(lockKey);
            }

            const processedHtml = this._processTemplate(html, data);

            // Apply transition if specified
            if (transition && !append) {
                await this._applyTransition(targetElement, transition, 'out');
            }

            if (shadow && this.config.enableShadowDOM) {
                await this._injectWithShadowDOM(
                    targetElement,
                    processedHtml,
                    executeScripts
                );
            } else {
                await this._injectWithDOM(
                    targetElement,
                    processedHtml,
                    append,
                    executeScripts
                );
            }

            // Apply enter transition
            if (transition && !append) {
                await this._applyTransition(targetElement, transition, 'in');
            }

            // Initialize component after injection
            await this.initializeComponent(
                componentName,
                targetElement,
                options
            );

            // Restore or manage focus
            if (preserveFocus && focusWasInTarget) {
                this._restoreFocus(targetElement, focusedElement);
            }

            return targetElement;
        } catch (error) {
            console.error(
                `Failed to inject component "${componentName}":`,
                error
            );
            throw error;
        } finally {
            this._releaseLock(lockKey);
        }
    }

    // Lock mechanism for preventing concurrent injections
    async _acquireLock(key) {
        while (this.injectionLocks.has(key)) {
            await this.injectionLocks.get(key);
        }

        let releaseLock;
        const lockPromise = new Promise((resolve) => {
            releaseLock = resolve;
        });

        this.injectionLocks.set(key, lockPromise);
        this._currentReleaseLock = releaseLock;
    }

    _releaseLock(key) {
        if (this._currentReleaseLock) {
            this._currentReleaseLock();
            this._currentReleaseLock = null;
        }
        this.injectionLocks.delete(key);
    }

    // Inject with proper script execution
    async _injectWithDOM(targetElement, html, append, executeScripts) {
        // Parse HTML and extract scripts
        const template = document.createElement('template');
        template.innerHTML = html;
        const fragment = template.content;

        const scripts = executeScripts
            ? Array.from(fragment.querySelectorAll('script'))
            : [];

        // Remove scripts from fragment (we'll execute them manually)
        scripts.forEach((script) => script.remove());

        if (append) {
            targetElement.appendChild(fragment);
        } else {
            targetElement.innerHTML = '';
            targetElement.appendChild(fragment);
        }

        // Execute scripts in order
        if (executeScripts) {
            for (const oldScript of scripts) {
                await this._executeScript(oldScript, targetElement);
            }
        }
    }

    async _executeScript(oldScript, container) {
        const newScript = document.createElement('script');

        // Copy attributes
        Array.from(oldScript.attributes).forEach((attr) => {
            newScript.setAttribute(attr.name, attr.value);
        });

        if (oldScript.src) {
            // External script - wait for load
            return new Promise((resolve, reject) => {
                newScript.onload = resolve;
                newScript.onerror = reject;
                newScript.src = oldScript.src;
                container.appendChild(newScript);
            });
        } else {
            // Inline script
            newScript.textContent = oldScript.textContent;
            container.appendChild(newScript);
        }
    }

    async _injectWithShadowDOM(element, html, executeScripts) {
        if (!element.shadowRoot) {
            element.attachShadow({ mode: 'open' });
        }

        // For shadow DOM, we need to handle styles and scripts specially
        const template = document.createElement('template');
        template.innerHTML = html;

        if (executeScripts) {
            const scripts = Array.from(
                template.content.querySelectorAll('script')
            );
            scripts.forEach((script) => script.remove());

            element.shadowRoot.innerHTML = '';
            element.shadowRoot.appendChild(template.content);

            for (const script of scripts) {
                await this._executeScript(script, element.shadowRoot);
            }
        } else {
            element.shadowRoot.innerHTML = html;
        }
    }

    // Transition handling
    async _applyTransition(element, transition, direction) {
        if (typeof transition === 'function') {
            await transition(element, direction);
            return;
        }

        // Built-in transitions
        switch (transition) {
            case 'fade':
                await this._fadeTransition(element, direction);
                break;
            case 'slide':
                await this._slideTransition(element, direction);
                break;
        }
    }

    async _fadeTransition(element, direction) {
        return new Promise((resolve) => {
            element.style.transition = 'opacity 0.3s ease';
            element.style.opacity = direction === 'out' ? '0' : '1';

            setTimeout(() => {
                if (direction === 'in') {
                    element.style.transition = '';
                }
                resolve();
            }, 300);
        });
    }

    async _slideTransition(element, direction) {
        return new Promise((resolve) => {
            const height = element.offsetHeight;
            element.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
            element.style.transform =
                direction === 'out' ? 'translateY(-20px)' : 'translateY(0)';
            element.style.opacity = direction === 'out' ? '0' : '1';

            setTimeout(() => {
                if (direction === 'in') {
                    element.style.transition = '';
                    element.style.transform = '';
                }
                resolve();
            }, 300);
        });
    }

    // Focus management
    _restoreFocus(container, previousFocus) {
        // Try to restore to previous element if still in DOM
        if (previousFocus && document.body.contains(previousFocus)) {
            previousFocus.focus();
            return;
        }

        // Otherwise focus first focusable element in new content
        const focusable = container.querySelector(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );

        if (focusable) {
            focusable.focus();
        }
    }

    // Component-specific initialization with plugin architecture
    async initializeComponent(componentName, element, options = {}) {
        const instanceKey = this._getInstanceKey(componentName, element);
        const initMethod = `initialize${this._toCamelCase(componentName)}`;

        if (typeof this[initMethod] === 'function') {
            await this[initMethod](element, options, instanceKey);
        }

        // Emit custom event for external listeners
        element.dispatchEvent(
            new CustomEvent('component:loaded', {
                detail: { componentName, options, instanceKey },
                bubbles: true,
                composed: true, // Cross shadow DOM boundary
            })
        );
    }

    _toCamelCase(str) {
        return str
            .replace(/-([a-z])/g, (g) => g[1].toUpperCase())
            .replace(/^[a-z]/, (g) => g.toUpperCase());
    }

    // Navigation initialization with cleanup tracking
    initializeNavigation(navElement, options = {}, instanceKey) {
        const mobileToggle = navElement.querySelector('[data-mobile-toggle]');
        const mobileMenu = navElement.querySelector('[data-mobile-menu]');

        if (mobileToggle && mobileMenu) {
            const toggleHandler = () => {
                const isExpanded = mobileMenu.classList.toggle('hidden');
                mobileToggle.setAttribute('aria-expanded', !isExpanded);

                // Manage focus
                if (!isExpanded) {
                    const firstLink = mobileMenu.querySelector('a, button');
                    firstLink?.focus();
                }
            };

            mobileToggle.addEventListener('click', toggleHandler);
            this._trackEventListener(
                instanceKey,
                mobileToggle,
                'click',
                toggleHandler
            );

            // Close menu on Escape
            const escapeHandler = (e) => {
                if (
                    e.key === 'Escape' &&
                    !mobileMenu.classList.contains('hidden')
                ) {
                    mobileMenu.classList.add('hidden');
                    mobileToggle.setAttribute('aria-expanded', 'false');
                    mobileToggle.focus();
                }
            };

            document.addEventListener('keydown', escapeHandler);
            this._trackEventListener(
                instanceKey,
                document,
                'keydown',
                escapeHandler
            );
        }

        // Highlight active navigation
        this._setActiveNavigation(navElement);

        // Handle smooth scrolling for anchor links
        this._initializeSmoothScroll(navElement, instanceKey);
    }

    _setActiveNavigation(navElement) {
        const currentPath = window.location.pathname;
        const navLinks = navElement.querySelectorAll('a[href]');

        navLinks.forEach((link) => {
            const linkPath = link.getAttribute('href');
            const isActive =
                currentPath.endsWith(linkPath) ||
                (currentPath.endsWith('/') && linkPath === 'index.html');

            if (isActive) {
                link.setAttribute('aria-current', 'page');
                link.classList.add('active');
            } else {
                link.removeAttribute('aria-current');
                link.classList.remove('active');
            }
        });
    }

    _initializeSmoothScroll(container, instanceKey) {
        const anchorLinks = container.querySelectorAll('a[href^="#"]');

        anchorLinks.forEach((link) => {
            const scrollHandler = (e) => {
                const targetId = link.getAttribute('href').slice(1);
                const targetElement = document.getElementById(targetId);

                if (targetElement) {
                    e.preventDefault();
                    targetElement.scrollIntoView({ behavior: 'smooth' });

                    // Manage focus for accessibility
                    targetElement.setAttribute('tabindex', '-1');
                    targetElement.focus();
                }
            };

            link.addEventListener('click', scrollHandler);
            this._trackEventListener(instanceKey, link, 'click', scrollHandler);
        });
    }

    // Contact form with validation
    initializeContactForm(formElement, options = {}, instanceKey) {
        const form = formElement.querySelector('form');
        if (!form) return;

        // Set up ARIA live region for validation messages
        let liveRegion = form.querySelector('[role="alert"]');
        if (!liveRegion) {
            liveRegion = document.createElement('div');
            liveRegion.setAttribute('role', 'alert');
            liveRegion.setAttribute('aria-live', 'polite');
            liveRegion.className = 'sr-only'; // Screen reader only
            form.insertBefore(liveRegion, form.firstChild);
        }

        const submitHandler = async (e) => {
            e.preventDefault();

            const validationResult = this._validateForm(form);
            if (!validationResult.valid) {
                liveRegion.textContent = `Form has ${validationResult.errors.length} errors. Please correct them.`;
                validationResult.errors[0].element.focus();
                return;
            }

            const formData = new FormData(form);
            const data = Object.fromEntries(formData);

            try {
                await this._submitForm(data, options.endpoint);
                form.reset();
                this._showFormMessage(
                    formElement,
                    'success',
                    'Form submitted successfully!'
                );
                liveRegion.textContent = 'Form submitted successfully';
            } catch (error) {
                this._showFormMessage(
                    formElement,
                    'error',
                    'Submission failed. Please try again.'
                );
                liveRegion.textContent = 'Submission failed. Please try again.';
            }
        };

        form.addEventListener('submit', submitHandler);
        this._trackEventListener(instanceKey, form, 'submit', submitHandler);

        // Real-time validation on blur
        const inputs = form.querySelectorAll('input, textarea, select');
        inputs.forEach((input) => {
            const blurHandler = () => this._validateInput(input);
            input.addEventListener('blur', blurHandler);
            this._trackEventListener(instanceKey, input, 'blur', blurHandler);
        });
    }

    _validateInput(input) {
        let errorMessage = '';

        if (input.hasAttribute('required') && !input.value.trim()) {
            errorMessage = 'This field is required';
        } else if (
            input.type === 'email' &&
            input.value &&
            !this._isValidEmail(input.value)
        ) {
            errorMessage = 'Please enter a valid email address';
        }

        if (errorMessage) {
            input.classList.add('error');
            input.setAttribute('aria-invalid', 'true');
            this._setInputError(input, errorMessage);
        } else {
            input.classList.remove('error');
            input.removeAttribute('aria-invalid');
            this._clearInputError(input);
        }
    }

    _validateForm(form) {
        const inputs = form.querySelectorAll('[required]');
        const errors = [];

        inputs.forEach((input) => {
            this._validateInput(input);
            if (input.classList.contains('error')) {
                errors.push({ element: input, message: 'Validation error' });
            }
        });

        return { valid: errors.length === 0, errors };
    }

    _isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    _setInputError(input, message) {
        let errorEl = input.parentElement.querySelector('.error-message');
        if (!errorEl) {
            errorEl = document.createElement('span');
            errorEl.className = 'error-message';
            errorEl.id = `${input.id || input.name}-error`;
            input.setAttribute('aria-describedby', errorEl.id);
            input.parentElement.appendChild(errorEl);
        }
        errorEl.textContent = message;
    }

    _clearInputError(input) {
        const errorEl = input.parentElement.querySelector('.error-message');
        if (errorEl) {
            errorEl.remove();
            input.removeAttribute('aria-describedby');
        }
    }

    async _submitForm(data, endpoint) {
        if (!endpoint) {
            console.warn('No form endpoint configured');
            return;
        }

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });

        if (!response.ok) throw new Error('Form submission failed');
        return response.json();
    }

    _showFormMessage(container, type, message) {
        const msgElement = document.createElement('div');
        msgElement.className = `form-message form-message-${type}`;
        msgElement.textContent = message;
        msgElement.setAttribute('role', type === 'error' ? 'alert' : 'status');
        msgElement.setAttribute('tabindex', '-1');

        container.insertBefore(msgElement, container.firstChild);
        msgElement.focus();

        setTimeout(() => msgElement.remove(), 5000);
    }

    // Event listener tracking for cleanup
    _trackEventListener(instanceKey, element, event, handler) {
        if (!this.eventHandlers.has(instanceKey)) {
            this.eventHandlers.set(instanceKey, []);
        }
        this.eventHandlers.get(instanceKey).push({ element, event, handler });
    }

    _cleanupEventListeners(instanceKey) {
        const handlers = this.eventHandlers.get(instanceKey);
        if (handlers) {
            handlers.forEach(({ element, event, handler }) => {
                element.removeEventListener(event, handler);
            });
            this.eventHandlers.delete(instanceKey);
        }
    }

    // Load multiple components with progress tracking
    async loadPageComponents(componentsMap, onProgress) {
        const entries = Object.entries(componentsMap);
        const total = entries.length;
        let loaded = 0;

        const loadPromises = entries.map(async ([componentName, config]) => {
            const target = typeof config === 'string' ? config : config.target;
            const options = typeof config === 'object' ? { ...config } : {};
            delete options.target;

            try {
                await this.injectComponent(componentName, target, options);
                loaded++;
                if (onProgress) onProgress(loaded, total, componentName);
            } catch (error) {
                console.error(`Failed to load ${componentName}:`, error);
            }
        });

        await Promise.all(loadPromises);
        this.initialized = true;

        document.dispatchEvent(new CustomEvent('components:ready'));
    }

    // Preload components without injecting
    async preloadComponents(componentNames) {
        return Promise.all(
            componentNames.map((name) => this.loadComponent(name))
        );
    }

    // Clear cache
    clearCache(componentName) {
        if (componentName) {
            this.components.delete(componentName);
        } else {
            this.components.clear();
        }
    }

    // Cleanup all resources
    destroy() {
        this.eventHandlers.forEach((handlers, instanceKey) => {
            this._cleanupEventListeners(instanceKey);
        });
        this.components.clear();
        this.loadingStates.clear();
        this.injectionLocks.clear();
        this.initialized = false;
    }
}

// Create global instance
window.componentLoader = new ComponentLoader({
    basePath: '/components',
    cacheEnabled: true,
    enableShadowDOM: false,
    executeScripts: true,
});
