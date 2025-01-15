const axios = require('axios');
const xml2js = require('xml2js');

const MSE_BASE_URL = 'http://127.0.0.1:8580';

const ContentTypes = {
    ATOM_FEED: 'application/atom+xml',
    ATOM_ENTRY: 'application/atom+xml;type=entry',
    VDF_ELEMENT: 'application/vnd.vizrt.payload+xml;type=element',
    VDF_PLAYLIST: 'application/vnd.vizrt.payload+xml;type=playlist',
    TEMPLATE_MODEL: 'application/vnd.vizrt.model+xml',
    PLAIN_TEXT: 'text/plain'
};

class MSEService {
    constructor() {
        this.parser = new xml2js.Parser({
            explicitArray: false,
            mergeAttrs: true,
        });
        
        // Accept multiple content types
        this.client = axios.create({
            baseURL: MSE_BASE_URL,
            headers: {
                'Accept': Object.values(ContentTypes).join(', ')
            }
        });
    }

    async parseXML(xmlData) {
        try {
            return await this.parser.parseStringPromise(xmlData);
        } catch (error) {
            console.error('XML parsing error:', error);
            throw error;
        }
    }

    _isDirectory(entry) {
        const categories = Array.isArray(entry.category) ? entry.category : [entry.category];
        const isDirectory = categories.some(cat => cat.term === 'directory');
        const isShow = categories.some(cat => cat.term === 'show');
        return isDirectory && !isShow;
    }

    async _fetchShowsRecursively(directoryUrl) {
        console.log('Fetching from directory:', directoryUrl);
        const response = await this.client.get(directoryUrl);
        const data = await this.parseXML(response.data);

        if (!data?.feed?.entry) return [];

        const entries = Array.isArray(data.feed.entry) ? data.feed.entry : [data.feed.entry];
        let shows = [];

        for (const entry of entries) {
            // Check if it's a show
            const isShow = Array.isArray(entry.category) ? 
                entry.category.some(cat => cat.term === 'show') :
                entry.category?.term === 'show';

            if (isShow) {
                const links = Array.isArray(entry.link) ? entry.link : [entry.link];
                const showData = {
                    name: entry.title,
                    url: links.find(l => l.rel === 'self')?.href,
                    alternateUrl: links.find(l => l.rel === 'alternate')?.href
                };

                // Fetch show details if we have an alternate URL
                if (showData.alternateUrl) {
                    const details = await this._fetchShowDetails(showData.alternateUrl);
                    shows.push({ ...showData, ...details });
                }
            }
            // Check if it's a directory
            else if (this._isDirectory(entry)) {
                const links = Array.isArray(entry.link) ? entry.link : [entry.link];
                const alternateLink = links.find(l => l.rel === 'alternate')?.href;
                
                if (alternateLink) {
                    // Recursively fetch shows from subdirectory
                    const subShows = await this._fetchShowsRecursively(alternateLink);
                    shows = shows.concat(subShows);
                }
            }
        }

        return shows;
    }

    async fetchAllShows() {
        try {
            console.log('Fetching shows recursively from:', '/directory/shows/');
            const shows = await this._fetchShowsRecursively('/directory/shows/');
            console.log('All shows found:', shows.length);
            return shows;
        } catch (error) {
            console.error('Error fetching all shows:', error);
            return [];
        }
    }

    async _fetchShowDetails(showUrl) {
        try {
            const response = await this.client.get(showUrl);
            const data = await this.parseXML(response.data);
            
            const details = {
                pages: [],
                templates: [],
                playlists: []
            };

            if (!data?.feed?.entry) return details;

            const entries = Array.isArray(data.feed.entry) ? data.feed.entry : [data.feed.entry];

            for (const entry of entries) {
                const categories = Array.isArray(entry.category) ? entry.category : [entry.category];
                const links = Array.isArray(entry.link) ? entry.link : [entry.link];
                const alternateLink = links.find(l => l.rel === 'alternate')?.href;

                if (!alternateLink) continue;

                // Handle playlists directory
                if (categories.some(cat => cat.term === 'directory')) {
                    const playlistsData = await this._fetchDirectory(alternateLink);
                    
                    for (const playlist of playlistsData) {
                        if (playlist.selfLink) {
                            const content = await this.fetchPlaylistContent(playlist.selfLink);
                            details.playlists.push({
                                name: playlist.title,
                                selfUrl: playlist.selfLink.replace('/directory/', '/element_collection/'),
                                templates: content || []
                            });
                        }
                    }
                }

                // Handle elements (pages)
                if (categories.some(cat => cat.term === 'elements')) {
                    const elementsData = await this._fetchElements(alternateLink);
                    details.pages = elementsData;
                }

                // Handle templates
                if (categories.some(cat => cat.term === 'templates')) {
                    const templatesData = await this._fetchTemplates(alternateLink);
                    details.templates = templatesData;
                }
            }

            return details;
        } catch (error) {
            console.error('Error fetching show details:', error);
            return { pages: [], templates: [], playlists: [] };
        }
    }

    async _fetchDirectory(url) {
        const response = await this.client.get(url);
        const data = await this.parseXML(response.data);

        if (!data?.feed?.entry) return [];

        const entries = Array.isArray(data.feed.entry) ? data.feed.entry : [data.feed.entry];
        
        return entries.map(entry => {
            const links = Array.isArray(entry.link) ? entry.link : [entry.link];
            return {
                title: entry.title,
                selfLink: links.find(l => l.rel === 'self')?.href
            };
        });
    }

    async _fetchElements(url) {
        const response = await this.client.get(url);
        const data = await this.parseXML(response.data);

        if (!data?.feed?.entry) return [];

        const entries = Array.isArray(data.feed.entry) ? data.feed.entry : [data.feed.entry];
        return entries.map(entry => entry.title);
    }

    async _fetchTemplates(url) {
        const response = await this.client.get(url);
        const data = await this.parseXML(response.data);

        if (!data?.feed?.entry) return [];

        const entries = Array.isArray(data.feed.entry) ? data.feed.entry : [data.feed.entry];
        return entries.map(entry => entry.title);
    }

    async fetchPlaylistContentForDropdown(playlistUrl) {
        try {
            console.log('Fetching playlist content for dropdown from:', playlistUrl);
            const response = await this.client.get(playlistUrl);
            const data = await this.parseXML(response.data);

            if (!data?.feed?.entry) {
                console.log('No entries found in feed');
                return [];
            }

            // Process entries
            const entries = Array.isArray(data.feed.entry) ? 
                data.feed.entry : [data.feed.entry];

            return entries.map(entry => {
                const payload = entry.content?.payload;
                if (!payload) return null;

                // Get links
                const links = Array.isArray(entry.link) ? entry.link : [entry.link];
                const selfLink = links.find(l => l.rel === 'self')?.href;

                // Get template name from model URL
                const modelUrl = payload.model || '';
                const templateName = modelUrl.split('/mastertemplates/').pop() || 'Unknown Template';

                // Process fields to get values (same as before)
                let values = [];
                if (payload.field) {
                    const processField = (field) => {
                        if (field.field) {
                            if (Array.isArray(field.field)) {
                                field.field.forEach(subField => processField(subField));
                            } else {
                                processField(field.field);
                            }
                        }

                        if (field.value) {
                            let value = field.value;
                            if (typeof value === 'string') {
                                value = value.trim();
                            } else if (typeof value === 'number') {
                                value = value.toString();
                            } else if (value['fo:wrapper']) {
                                const wrapper = value['fo:wrapper'];
                                value = typeof wrapper === 'string' ? 
                                    wrapper.trim() : 
                                    (wrapper._ || '').trim();
                            }
                            if (value) values.push(value);
                        }
                    };

                    const fields = Array.isArray(payload.field) ? payload.field : [payload.field];
                    fields.forEach(field => processField(field));
                }

                return {
                    title: entry.title,
                    selfUrl: selfLink,
                    template: templateName,
                    values: values
                };
            }).filter(entry => entry !== null);

        } catch (error) {
            console.error('Error fetching playlist content for dropdown:', error);
            if (error.response) {
                console.error('Response status:', error.response.status);
                console.error('Response data:', error.response.data);
            }
            return [];
        }
    }

    async fetchPlaylistContent(playlistUrl) {
        try {
            // First fetch the playlist entry to get the alternate link
            const response = await this.client.get(playlistUrl);
            const data = await this.parseXML(response.data);

            if (!data?.entry?.link) return [];

            // Find the alternate link that contains the actual content
            const links = Array.isArray(data.entry.link) ? data.entry.link : [data.entry.link];
            const alternateLink = links.find(l => l.rel === 'alternate')?.href;

            if (!alternateLink) return [];

            // Fetch the actual content
            const contentResponse = await this.client.get(alternateLink);
            const contentData = await this.parseXML(contentResponse.data);

            if (!contentData?.feed?.entry) return [];

            // Process entries
            const entries = Array.isArray(contentData.feed.entry) ? 
                contentData.feed.entry : [contentData.feed.entry];

            return entries.map(entry => {
                const payload = entry.content?.payload;
                if (!payload) return null;

                // Get template name from model URL
                const modelUrl = payload.model || '';
                const templateName = modelUrl.split('/mastertemplates/').pop() || 'Unknown Template';

                // Process fields to get values
                let values = [];
                if (payload.field) {
                    const processField = (field) => {
                        // Handle nested fields
                        if (field.field) {
                            if (Array.isArray(field.field)) {
                                field.field.forEach(subField => processField(subField));
                            } else {
                                processField(field.field);
                            }
                        }

                        // Handle field value
                        if (field.value) {
                            let value = field.value;
                            
                            // Handle different value formats
                            if (typeof value === 'string') {
                                value = value.trim();
                            } else if (typeof value === 'number') {
                                value = value.toString();
                            } else if (value['fo:wrapper']) {
                                // Handle fo:wrapper format
                                const wrapper = value['fo:wrapper'];
                                value = typeof wrapper === 'string' ? 
                                    wrapper.trim() : 
                                    (wrapper._ || '').trim();
                            }

                            if (value) values.push(value);
                        }
                    };

                    const fields = Array.isArray(payload.field) ? payload.field : [payload.field];
                    fields.forEach(field => processField(field));
                }

                console.log('Processed template:', {
                    title: entry.title,
                    template: templateName,
                    values: values
                });

                return {
                    title: entry.title,
                    template: templateName,
                    values: values
                };
            }).filter(entry => entry !== null);

        } catch (error) {
            console.error('Error fetching playlist content:', error);
            if (error.response) {
                console.error('Response data:', error.response.data);
            }
            return [];
        }
    }

    async fetchProfiles() {
        try {
            const response = await this.client.get('/profiles');
            const data = await this.parseXML(response.data);
            
            if (!data?.feed?.entry) return [];

            const entries = Array.isArray(data.feed.entry) ? 
                data.feed.entry : [data.feed.entry];

            return entries.map(entry => {
                const links = Array.isArray(entry.link) ? entry.link : [entry.link];
                const getLink = (rel) => links.find(l => l.rel === rel)?.href;

                return {
                    name: entry.title,
                    takeUrl: getLink('take'),
                    continueUrl: getLink('continue'),
                    outUrl: getLink('out'),
                    initializeUrl: getLink('initialize'),
                    cleanupUrl: getLink('cleanup')
                };
            });
        } catch (error) {
            console.error('Error fetching profiles:', error);
            return [];
        }
    }

    async executeProfileCommand(commandUrl, elementUrl) {
        try {
            await this.client.post(commandUrl, elementUrl, {
                headers: {
                    'Content-Type': ContentTypes.PLAIN_TEXT
                }
            });
            return true;
        } catch (error) {
            console.error('Error executing profile command:', error);
            throw error;
        }
    }
}

module.exports = new MSEService();