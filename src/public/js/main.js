class MSEViewer {
    constructor() {
        // Initialize element references
        this.showSelect = document.getElementById('showSelect');
        this.playlistSelect = document.getElementById('playlistSelect');
        this.pageSelect = document.getElementById('pageSelect');
        this.takeButton = document.getElementById('takeButton');
        this.continueButton = document.getElementById('continueButton');
        this.outButton = document.getElementById('outButton');
        this.cleanupButton = document.getElementById('cleanupButton');
        this.showsTableBody = document.querySelector('#showsTable tbody');

        // Initialize data
        this.shows = [];
        this.profiles = [];

        // Set up event listeners
        this.setupEventListeners();

        // Load initial data
        this.loadInitialData();
    }

    setupEventListeners() {
        this.showSelect.addEventListener('change', () => this.handleShowSelection());
        this.playlistSelect.addEventListener('change', () => this.handlePlaylistSelection());
        this.pageSelect.addEventListener('change', () => this.handlePageSelection());
        this.takeButton.addEventListener('click', () => this.executeCommand('take'));
        this.continueButton.addEventListener('click', () => this.executeCommand('continue'));
        this.outButton.addEventListener('click', () => this.executeCommand('out'));
        this.cleanupButton.addEventListener('click', () => this.handleCleanup());
    }

    async loadInitialData() {
        try {
            this.showsTableBody.innerHTML = `
                <tr>
                    <td colspan="6" class="text-center py-4">
                        <div class="spinner-border text-primary" role="status">
                            <span class="visually-hidden">Loading...</span>
                        </div>
                        <div class="mt-2">Loading data...</div>
                    </td>
                </tr>
            `;

            const [shows, profiles] = await Promise.all([
                fetch('/api/shows').then(res => res.json()),
                fetch('/api/profiles').then(res => res.json())
            ]);

            this.shows = shows;
            this.profiles = profiles;

            this.populateShowsDropdown();
            this.populateShowsTable();
        } catch (error) {
            console.error('Failed to load initial data:', error);
            this.showError('Failed to load data');
        }
    }

    populateShowsDropdown() {
        this.showSelect.innerHTML = '<option value="">Choose a show...</option>';
        
        // Filter shows that have non-empty playlists
        const showsWithContent = this.shows.filter(show => 
            show.playlists?.some(playlist => 
                playlist.templates?.length > 0
            )
        );

        showsWithContent.forEach(show => {
            const option = document.createElement('option');
            option.value = show.url;
            option.textContent = show.name;
            this.showSelect.appendChild(option);
        });
    }

    populateShowsTable() {
        this.showsTableBody.innerHTML = this.shows.map((show, index) => {
            const path = new URL(show.url).pathname.replace('/directory/', '').replace('.show', '');
            
            return `
                <tr>
                    <td>${show.name || 'Unnamed Show'}</td>
                    <td>${path}</td>
                    <td><a href="${show.url}" target="_blank" class="link-primary">${show.url}</a></td>
                    <td>${this.createPagesSection(show, index)}</td>
                    <td>${this.createTemplatesSection(show, index)}</td>
                    <td>${this.createPlaylistsSection(show, index)}</td>
                </tr>
            `;
        }).join('');
    }

    createPagesSection(show, index) {
        if (!show.pages?.length) return '0 pages';
        return this.createCollapsibleSection(
            `pages${index}`,
            `${show.pages.length} pages`,
            `<ol class="mb-0">${show.pages.map(page => `<li>${page}</li>`).join('')}</ol>`
        );
    }

    createTemplatesSection(show, index) {
        if (!show.templates?.length) return '0 templates';
        return this.createCollapsibleSection(
            `templates${index}`,
            `${show.templates.length} templates`,
            `<ol class="mb-0">${show.templates.map(template => `<li>${template}</li>`).join('')}</ol>`
        );
    }

    createPlaylistsSection(show, index) {
        if (!show.playlists?.length) return 'No Playlists';

        return show.playlists.map((playlist, playlistIndex) => {
            const content = playlist.templates?.map(template => {
                const valuesHtml = template.values?.map(value => `
                    <div class="ms-4">${value}</div>
                `).join('\n') || '';

                return `
                    <div class="template-item mb-2">
                        <div class="fw-bold">${template.template}</div>
                        ${valuesHtml}
                    </div>
                `;
            }).join('\n') || 'No templates';

            return this.createCollapsibleSection(
                `playlist${index}_${playlistIndex}`,
                playlist.name,
                content
            );
        }).join('\n');
    }

    createCollapsibleSection(id, title, content) {
        return `
            <div>
                <button class="btn btn-link p-0 text-start text-decoration-none" type="button" 
                        data-bs-toggle="collapse" data-bs-target="#${id}" 
                        aria-expanded="false">
                    <i class="bi bi-chevron-down collapse-icon me-1"></i>
                    ${title}
                </button>
                <div class="collapse" id="${id}">
                    <div class="card card-body mt-2">
                        ${content}
                    </div>
                </div>
            </div>
        `;
    }

    handleShowSelection() {
        const selectedShow = this.shows.find(s => s.url === this.showSelect.value);
        
        this.playlistSelect.innerHTML = '<option value="">Choose a playlist...</option>';
        this.pageSelect.innerHTML = '<option value="">Choose a page...</option>';
        this.playlistSelect.disabled = true;
        this.pageSelect.disabled = true;
        this.disableActionButtons();

        if (selectedShow?.playlists?.length) {
            this.playlistSelect.disabled = false;
            selectedShow.playlists.forEach(playlist => {
                const option = document.createElement('option');
                option.value = playlist.selfUrl;
                option.textContent = playlist.name;
                this.playlistSelect.appendChild(option);
            });
        }

        this.cleanupButton.disabled = !selectedShow;
    }

    async handlePlaylistSelection() {
        if (!this.playlistSelect.value) {
            this.pageSelect.disabled = true;
            this.disableActionButtons();
            return;
        }

        try {
            const response = await fetch(`/api/playlist-content-dropdown?url=${encodeURIComponent(this.playlistSelect.value)}`);
            const templates = await response.json();
            
            console.log('Playlist content for dropdown:', templates);

            this.pageSelect.innerHTML = '<option value="">Choose a page...</option>';
            templates.forEach(template => {
                if (template.selfUrl && template.values.length > 0) {
                    const option = document.createElement('option');
                    option.value = template.selfUrl;
                    
                    // Get the first value as description
                    let description = template.values[0] || '';
                    if (description.length > 20) {
                        description = description.substring(0, 20) + '...';
                    }
                    
                    // Create a temporary div to hold the styled content
                    const tempDiv = document.createElement('div');
                    tempDiv.innerHTML = `${template.template}: <strong>${description}</strong>`;
                    option.textContent = tempDiv.textContent; // This will include the styling
                    
                    this.pageSelect.appendChild(option);
                }
            });
            
            this.pageSelect.disabled = templates.length === 0;
            
        } catch (error) {
            console.error('Failed to load playlist content:', error);
            this.showError('Failed to load pages');
        }
    }

    handlePageSelection() {
        const hasPage = Boolean(this.pageSelect.value);
        this.takeButton.disabled = !hasPage;
        this.continueButton.disabled = !hasPage;
        this.outButton.disabled = !hasPage;
    }

    async executeCommand(command) {
        if (!this.pageSelect.value || !this.profiles.length) return;

        try {
            const profile = this.profiles[0];
            const commandUrl = profile[`${command}Url`];
            
            if (!commandUrl) {
                this.showError(`Command ${command} not available`);
                return;
            }

            const response = await fetch('/api/profile-command', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    commandUrl,
                    elementUrl: this.pageSelect.value
                })
            });

            const result = await response.json();
            if (result.success) {
                this.showSuccess(`${command} command executed successfully`);
            } else {
                this.showError(result.error || `The ${command} command failed`);
            }
        } catch (error) {
            console.error(`Failed to execute ${command} command:`, error);
            this.showError(`Failed to execute ${command} command`);
        }
    }

    async handleCleanup() {
        if (!this.showSelect.value || !this.profiles.length) return;

        if (confirm('WARNING: This will clean up and reactivate the show pagelist. Are you sure?')) {
            try {
                const profile = this.profiles[0];
                const selectedShow = this.shows.find(s => s.url === this.showSelect.value);
                
                if (!selectedShow || !profile.cleanupUrl) {
                    this.showError('Missing show or cleanup URL');
                    return;
                }

                // First, cleanup
                const cleanupResponse = await fetch('/api/profile-command', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        commandUrl: profile.cleanupUrl,
                        elementUrl: selectedShow.alternateUrl.replace('/show/', '/element_collection/storage/shows/')
                    })
                });

                const cleanupResult = await cleanupResponse.json();
                if (!cleanupResult.success) {
                    throw new Error('Cleanup failed');
                }

                // Then, initialize
                const initializeResponse = await fetch('/api/profile-command', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        commandUrl: profile.initializeUrl,
                        elementUrl: selectedShow.alternateUrl.replace('/show/', '/element_collection/storage/shows/')
                    })
                });

                const initializeResult = await initializeResponse.json();
                if (!initializeResult.success) {
                    throw new Error('Initialize failed');
                }

                this.showSuccess('Cleanup and reactivation successful');
            } catch (error) {
                console.error('Error during cleanup:', error);
                this.showError('Failed to cleanup and reactivate: ' + error.message);
            }
        }
    }

    disableActionButtons() {
        this.takeButton.disabled = true;
        this.continueButton.disabled = true;
        this.outButton.disabled = true;
    }

    showSuccess(message) {
        const toast = document.getElementById('successToast');
        const toastBody = toast.querySelector('.toast-body');
        toastBody.textContent = message;
        const bsToast = new bootstrap.Toast(toast);
        bsToast.show();
    }

    showError(message) {
        const toast = document.getElementById('errorToast');
        const toastBody = toast.querySelector('.toast-body');
        toastBody.textContent = message;
        const bsToast = new bootstrap.Toast(toast);
        bsToast.show();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new MSEViewer();
});