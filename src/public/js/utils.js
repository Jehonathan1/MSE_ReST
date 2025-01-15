// Toast notification handlers
const showToast = (message, type = 'success') => {
    const toastElement = document.getElementById(`${type}Toast`);
    const toastBody = toastElement.querySelector('.toast-body');
    toastBody.textContent = message;
    const bsToast = new bootstrap.Toast(toastElement);
    bsToast.show();
};

const showSuccess = (message) => showToast(message, 'success');
const showError = (message) => showToast(message, 'error');

// API calls
const api = {
    async get(endpoint) {
        try {
            const response = await fetch(endpoint);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error('API Get Error:', error);
            showError('Failed to fetch data');
            throw error;
        }
    },

    async post(endpoint, data) {
        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.error('API Post Error:', error);
            showError('Failed to execute command');
            throw error;
        }
    }
};

// UI helpers
const UIHelpers = {
    disableControls() {
        document.getElementById('playlistSelect').disabled = true;
        document.getElementById('pageSelect').disabled = true;
        document.getElementById('takeButton').disabled = true;
        document.getElementById('continueButton').disabled = true;
        document.getElementById('outButton').disabled = true;
        document.getElementById('cleanupButton').disabled = true;
    },

    createCollapsibleSection(id, title, content) {
        return `
            <button class="btn btn-link p-0" type="button" 
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
        `;
    },

    generatePlaylistContent(playlists, showIndex) {
        if (!Array.isArray(playlists) || playlists.length === 0) return 'No Playlists';
        
        return playlists.map((playlist, playlistIndex) => {
            if (!playlist?.templates) {
                return `<div class="playlist-item mb-2">
                    <strong>${playlist?.name || 'Unnamed Playlist'}</strong> (Empty)
                </div>`;
            }

            const templatesList = playlist.templates
                .map((template, templateIndex) => `
                    <div class="template-item">
                        <strong>${templateIndex + 1}. ${template.template || 'Unnamed Template'}</strong>
                    </div>
                `).join('');

            return UIHelpers.createCollapsibleSection(
                `playlist${showIndex}_${playlistIndex}`,
                playlist.name || 'Unnamed Playlist',
                templatesList
            );
        }).join('');
    }
};

// Export utilities
window.showSuccess = showSuccess;
window.showError = showError;
window.api = api;
window.UIHelpers = UIHelpers;