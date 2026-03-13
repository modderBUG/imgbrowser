class ImageGallery {
    constructor() {
        this.gallery = document.getElementById('gallery');
        this.loading = document.getElementById('loading');
        this.endMessage = document.getElementById('end-message');
        this.totalImagesSpan = document.getElementById('total-images');
        this.loadedCountSpan = document.getElementById('loaded-count');
        this.backToTopBtn = document.getElementById('backToTop');
        this.sortSelect = document.getElementById('sort');
        
        // 模态框元素
        this.modal = document.getElementById('image-modal');
        this.modalImage = document.getElementById('modal-image');
        this.modalFilename = document.getElementById('modal-filename');
        this.modalDetails = document.getElementById('modal-details');
        this.modalClose = document.querySelector('.modal-close');
        this.prevBtn = document.querySelector('.prev-btn');
        this.nextBtn = document.querySelector('.next-btn');
        this.favoriteBtn = document.querySelector('.favorite-btn');
        this.deleteBtn = document.querySelector('.delete-btn');
        this.zoomBtn = document.querySelector('.zoom-btn');
        
        this.currentPage = 1;
        this.limit = 20;
        this.totalImages = 0;
        this.loadedImages = 0;
        this.isLoading = false;
        this.hasMore = true;
        this.viewMode = 'waterfall';
        this.sortBy = 'name';
        this.showMode = 'all'; // 'all', 'favorites', 'deleted'
        
        // 当前显示的图片列表和模态框状态
        this.currentImages = [];
        this.currentModalIndex = -1;
        this.isZoomed = false;
        this.dragStart = { x: 0, y: 0 };
        this.imageOffset = { x: 0, y: 0 };
        
        this.init();
    }
    
    init() {
        this.setupEventListeners();
        this.loadImages();
        this.updateStats();
        
        // 初始隐藏加载和结束消息
        this.loading.style.display = 'none';
        this.endMessage.style.display = 'none';
        
        // 检查认证状态
        this.checkAuthStatus();
    }
    
    setupEventListeners() {
        // 无限滚动
        window.addEventListener('scroll', () => this.handleScroll());
        
        // 视图切换按钮
        document.querySelectorAll('.view-options .btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchView(e.target.dataset.view));
        });
        
        // 导航标签
        document.querySelectorAll('.nav-tabs .tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.switchTab(e.target.dataset.show));
        });
        
        // 排序选择
        this.sortSelect.addEventListener('change', (e) => {
            this.sortBy = e.target.value;
            this.resetAndReload();
        });
        
        // 返回顶部按钮
        this.backToTopBtn.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        
        // 显示/隐藏返回顶部按钮
        window.addEventListener('scroll', () => {
            this.backToTopBtn.style.display = window.scrollY > 300 ? 'block' : 'none';
        });
        
        // 登出按钮
        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => this.logout());
        }
        
        // 模态框事件
        this.modalClose.addEventListener('click', () => this.closeModal());
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) this.closeModal();
        });
        this.prevBtn.addEventListener('click', () => this.showPrevImage());
        this.nextBtn.addEventListener('click', () => this.showNextImage());
        this.favoriteBtn.addEventListener('click', () => this.toggleFavoriteModal());
        this.deleteBtn.addEventListener('click', () => this.deleteImageModal());
        this.zoomBtn.addEventListener('click', () => this.toggleZoom());
        
        // 键盘快捷键
        document.addEventListener('keydown', (e) => this.handleKeydown(e));
        
        // 图片拖拽
        this.modalImage.addEventListener('mousedown', (e) => this.startDrag(e));
        this.modalImage.addEventListener('touchstart', (e) => this.startDrag(e.touches[0]));
        document.addEventListener('mousemove', (e) => this.drag(e));
        document.addEventListener('touchmove', (e) => this.drag(e.touches[0]));
        document.addEventListener('mouseup', () => this.endDrag());
        document.addEventListener('touchend', () => this.endDrag());
        
        // 双击放大
        this.modalImage.addEventListener('dblclick', () => this.toggleZoom());
    }
    
    switchView(view) {
        this.viewMode = view;
        this.gallery.className = `gallery ${view}`;
        
        // 更新按钮活动状态
        document.querySelectorAll('.view-options .btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.view === view);
        });
        
        // 重新排列图片（简单实现）
        this.rearrangeGallery();
    }
    
    switchTab(show) {
        this.showMode = show;
        this.currentPage = 1;
        this.loadedImages = 0;
        this.hasMore = true;
        
        // 更新标签活动状态
        document.querySelectorAll('.nav-tabs .tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.show === show);
        });
        
        // 清空画廊并重新加载
        this.gallery.innerHTML = '';
        this.endMessage.style.display = 'none';
        this.loadImages();
    }
    
    rearrangeGallery() {
        // 可根据视图模式调整布局，这里仅做示例
        console.log(`切换到 ${this.viewMode} 视图`);
    }
    

    
    addImageCard(img) {
        const card = document.createElement('div');
        card.className = `image-card ${img.deleted ? 'deleted' : ''}`;
        card.dataset.id = img.id;
        
        // 从URL提取图片尺寸信息（模拟）
        const width = 300 + Math.floor(Math.random() * 200);
        const height = 200 + Math.floor(Math.random() * 300);
        
        // 操作按钮
        const actionsHtml = img.deleted ? `
            <div class="image-actions">
                <button class="action-btn restore-btn" title="恢复"><i class="fas fa-undo"></i></button>
                <button class="action-btn delete-btn" title="永久删除"><i class="fas fa-trash-alt"></i></button>
            </div>
        ` : `
            <div class="image-actions">
                <button class="action-btn favorite-btn ${img.favorited ? 'active' : ''}" title="${img.favorited ? '取消收藏' : '收藏'}">
                    <i class="fas fa-heart"></i>
                </button>
                <button class="action-btn delete-btn" title="删除"><i class="fas fa-trash"></i></button>
            </div>
        `;
        
        card.innerHTML = `
            ${actionsHtml}
            <img src="${img.url}" alt="${img.filename}" loading="lazy" width="${width}" height="${height}">
            <div class="image-info">
                <h3>${img.filename}</h3>
                <p><i class="fas fa-file-image"></i> ${width} × ${height} px</p>
                ${img.favorited ? '<p><i class="fas fa-heart" style="color: #ef4444;"></i> 已收藏</p>' : ''}
            </div>
        `;
        
        // 点击图片打开模态框
        const imgElement = card.querySelector('img');
        imgElement.addEventListener('click', (e) => {
            e.stopPropagation();
            this.openModal(img.id);
        });
        
        // 操作按钮事件
        const favoriteBtn = card.querySelector('.favorite-btn');
        if (favoriteBtn) {
            favoriteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleFavorite(img.id, favoriteBtn);
            });
        }
        
        const deleteBtn = card.querySelector('.delete-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (img.deleted) {
                    this.permanentlyDelete(img.id, card);
                } else {
                    this.deleteImage(img.id, card);
                }
            });
        }
        
        const restoreBtn = card.querySelector('.restore-btn');
        if (restoreBtn) {
            restoreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.restoreImage(img.id, card);
            });
        }
        
        this.gallery.appendChild(card);
    }
    
    async toggleFavorite(id, button) {
        try {
            const response = await fetch(`/api/images/${id}/favorite`, {
                method: 'POST'
            });
            
            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    // 从按钮的当前状态推断新的收藏状态
                    let isFavorited = false;
                    if (button) {
                        // 按钮切换后的状态就是新的收藏状态
                        button.classList.toggle('active');
                        isFavorited = button.classList.contains('active');
                        button.title = isFavorited ? '取消收藏' : '收藏';
                    } else {
                        // 如果没有按钮参数，从当前图片状态推断
                        const imageIndex = this.currentImages.findIndex(img => img.id === id);
                        if (imageIndex !== -1) {
                            isFavorited = !this.currentImages[imageIndex].favorited;
                            this.currentImages[imageIndex].favorited = isFavorited;
                        }
                    }
                    
                    // 更新模态框中的按钮状态（如果当前显示的是同一张图片）
                    if (this.currentModalIndex >= 0 && this.currentImages[this.currentModalIndex]?.id === id) {
                        this.favoriteBtn.classList.toggle('active');
                    }
                    
                    // 更新当前图片列表中的状态
                    const imageIndex = this.currentImages.findIndex(img => img.id === id);
                    if (imageIndex !== -1) {
                        this.currentImages[imageIndex].favorited = isFavorited;
                    }
                    
                    // 更新图片卡片上的收藏状态
                    this.updateImageCardFavoriteStatus(id, isFavorited);
                    
                    // 如果在收藏夹视图中，重新加载
                    if (this.showMode === 'favorites') {
                        this.resetAndReload();
                    }
                }
            }
        } catch (error) {
            console.error('切换收藏状态失败:', error);
        }
    }
    
    updateImageCardFavoriteStatus(id, isFavorited) {
        // 查找对应的图片卡片
        const card = document.querySelector(`.image-card[data-id="${id}"]`);
        if (!card) return;
        
        // 更新卡片上的收藏按钮
        const favoriteBtn = card.querySelector('.favorite-btn');
        if (favoriteBtn) {
            favoriteBtn.classList.toggle('active', isFavorited);
            favoriteBtn.title = isFavorited ? '取消收藏' : '收藏';
        }
        
        // 更新卡片上的"已收藏"文本
        const imageInfo = card.querySelector('.image-info');
        if (imageInfo) {
            // 先查找现有的"已收藏"文本（可能由addImageCard函数创建）
            let existingFavoritedText = null;
            const paragraphs = imageInfo.querySelectorAll('p');
            paragraphs.forEach(p => {
                if (p.innerHTML.includes('fa-heart') && p.innerHTML.includes('已收藏')) {
                    existingFavoritedText = p;
                }
            });
            
            if (isFavorited) {
                if (!existingFavoritedText) {
                    const favoritedText = document.createElement('p');
                    favoritedText.innerHTML = '<i class="fas fa-heart" style="color: #ef4444;"></i> 已收藏';
                    imageInfo.appendChild(favoritedText);
                }
            } else {
                if (existingFavoritedText) {
                    existingFavoritedText.remove();
                }
            }
        }
    }
    
    async deleteImage(id, card) {
        if (!confirm('确定要删除这张图片吗？图片将移动到回收站。')) return;
        
        try {
            const response = await fetch(`/api/images/${id}/delete`, {
                method: 'POST'
            });
            
            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    card.classList.add('deleted');
                    card.querySelector('.image-actions').innerHTML = `
                        <button class="action-btn restore-btn" title="恢复"><i class="fas fa-undo"></i></button>
                        <button class="action-btn delete-btn" title="永久删除"><i class="fas fa-trash-alt"></i></button>
                    `;
                    
                    // 更新按钮事件
                    const restoreBtn = card.querySelector('.restore-btn');
                    const deleteBtn = card.querySelector('.delete-btn');
                    
                    restoreBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.restoreImage(id, card);
                    });
                    
                    deleteBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.permanentlyDelete(id, card);
                    });
                    
                    // 如果在所有图片视图中，重新加载
                    if (this.showMode === 'all') {
                        this.resetAndReload();
                    }
                }
            }
        } catch (error) {
            console.error('删除图片失败:', error);
        }
    }
    
    async restoreImage(id, card) {
        try {
            const response = await fetch(`/api/images/${id}/restore`, {
                method: 'POST'
            });
            
            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    card.classList.remove('deleted');
                    card.querySelector('.image-actions').innerHTML = `
                        <button class="action-btn favorite-btn" title="收藏"><i class="fas fa-heart"></i></button>
                        <button class="action-btn delete-btn" title="删除"><i class="fas fa-trash"></i></button>
                    `;
                    
                    // 更新按钮事件
                    const favoriteBtn = card.querySelector('.favorite-btn');
                    const deleteBtn = card.querySelector('.delete-btn');
                    
                    favoriteBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.toggleFavorite(id, favoriteBtn);
                    });
                    
                    deleteBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.deleteImage(id, card);
                    });
                    
                    // 如果在回收站视图中，重新加载
                    if (this.showMode === 'deleted') {
                        this.resetAndReload();
                    }
                }
            }
        } catch (error) {
            console.error('恢复图片失败:', error);
        }
    }
    
    async permanentlyDelete(id, card) {
        if (!confirm('确定要永久删除这张图片吗？此操作不可撤销。')) return;
        
        try {
            const response = await fetch(`/api/images/${id}`, {
                method: 'DELETE'
            });
            
            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    card.remove();
                    this.totalImages--;
                    this.updateStats();
                }
            }
        } catch (error) {
            console.error('永久删除失败:', error);
        }
    }
    
    openModal(id) {
        const index = this.currentImages.findIndex(img => img.id === id);
        if (index === -1) return;
        
        this.currentModalIndex = index;
        this.showImageInModal();
        this.modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }
    
    closeModal() {
        this.modal.style.display = 'none';
        document.body.style.overflow = 'auto';
        this.isZoomed = false;
        this.resetImageTransform();
    }
    
    showImageInModal() {
        const img = this.currentImages[this.currentModalIndex];
        if (!img) return;
        
        this.modalImage.src = img.url;
        this.modalFilename.textContent = img.filename;
        this.modalDetails.textContent = `尺寸: ${img.width || '未知'} × ${img.height || '未知'} | 创建时间: ${new Date(img.created_at).toLocaleString()}`;
        
        // 更新按钮状态
        this.favoriteBtn.classList.toggle('active', img.favorited);
        this.deleteBtn.innerHTML = img.deleted ? '<i class="fas fa-trash-alt"></i>' : '<i class="fas fa-trash"></i>';
        this.deleteBtn.title = img.deleted ? '永久删除' : '删除';
        
        // 重置缩放和位置
        this.resetImageTransform();
    }
    
    showPrevImage() {
        if (this.currentModalIndex > 0) {
            this.currentModalIndex--;
            this.showImageInModal();
        }
    }
    
    showNextImage() {
        if (this.currentModalIndex < this.currentImages.length - 1) {
            this.currentModalIndex++;
            this.showImageInModal();
        }
    }
    
    async toggleFavoriteModal() {
        const img = this.currentImages[this.currentModalIndex];
        if (!img) return;
        
        await this.toggleFavorite(img.id, this.favoriteBtn);
    }
    
    async deleteImageModal() {
        const img = this.currentImages[this.currentModalIndex];
        if (!img) return;
        
        if (img.deleted) {
            await this.permanentlyDelete(img.id, null);
            this.closeModal();
        } else {
            await this.deleteImage(img.id, null);
            this.closeModal();
        }
    }
    
    toggleZoom() {
        this.isZoomed = !this.isZoomed;
        if (this.isZoomed) {
            this.modalImage.style.transform = 'scale(2)';
            this.modalImage.style.cursor = 'grab';
        } else {
            this.resetImageTransform();
        }
    }
    
    resetImageTransform() {
        this.modalImage.style.transform = 'scale(1) translate(0, 0)';
        this.modalImage.style.cursor = 'default';
        this.imageOffset = { x: 0, y: 0 };
    }
    
    startDrag(e) {
        if (!this.isZoomed) return;
        this.dragStart = { x: e.clientX - this.imageOffset.x, y: e.clientY - this.imageOffset.y };
        this.modalImage.style.cursor = 'grabbing';
    }
    
    drag(e) {
        if (!this.isZoomed) return;
        e.preventDefault();
        this.imageOffset = { x: e.clientX - this.dragStart.x, y: e.clientY - this.dragStart.y };
        this.modalImage.style.transform = `scale(2) translate(${this.imageOffset.x}px, ${this.imageOffset.y}px)`;
    }
    
    endDrag() {
        this.modalImage.style.cursor = 'grab';
    }
    
    handleKeydown(e) {
        if (this.modal.style.display === 'none') return;
        
        switch (e.key) {
            case 'Escape':
                this.closeModal();
                break;
            case 'ArrowLeft':
                this.showPrevImage();
                break;
            case 'ArrowRight':
                this.showNextImage();
                break;
            case 'f':
            case 'F':
                this.toggleFavoriteModal();
                break;
            case 'd':
            case 'D':
                this.deleteImageModal();
                break;
            case ' ':
                e.preventDefault();
                this.toggleZoom();
                break;
        }
    }
    
    updateStats() {
        this.totalImagesSpan.textContent = `${this.totalImages} 张图片`;
        this.loadedCountSpan.textContent = `已加载 ${this.loadedImages} 张`;
    }
    
    showEndMessage() {
        this.endMessage.style.display = 'block';
    }
    
    handleScroll() {
        const scrollTop = document.documentElement.scrollTop || document.body.scrollTop;
        const windowHeight = window.innerHeight;
        const docHeight = document.documentElement.scrollHeight;
        
        // 滚动到底部附近（距离底部 200px 内）时加载更多
        if (docHeight - (scrollTop + windowHeight) < 200) {
            this.loadImages();
        }
    }
    
    resetAndReload() {
        // 重置状态
        this.gallery.innerHTML = '';
        this.currentPage = 1;
        this.loadedImages = 0;
        this.hasMore = true;
        this.endMessage.style.display = 'none';
        this.currentImages = [];
        
        // 重新加载
        this.loadImages();
    }
    
    // 检查认证状态
    async checkAuthStatus() {
        try {
            const response = await fetch('/api/auth/status');
            if (response.ok) {
                const data = await response.json();
                if (!data.authenticated) {
                    // 未认证，重定向到登录页面
                    window.location.href = '/login.html';
                }
            } else {
                // API请求失败，可能是未认证
                window.location.href = '/login.html';
            }
        } catch (error) {
            console.error('检查认证状态失败:', error);
            // 网络错误，可能是服务器问题
        }
    }
    
    // 登出
    async logout() {
        if (!confirm('确定要登出吗？')) return;
        
        try {
            const response = await fetch('/api/logout', {
                method: 'POST'
            });
            
            if (response.ok) {
                // 登出成功，重定向到登录页面
                window.location.href = '/login.html';
            } else {
                alert('登出失败，请重试');
            }
        } catch (error) {
            console.error('登出失败:', error);
            alert('登出失败，请检查网络连接');
        }
    }
    
    // 修改loadImages方法以处理认证错误
    async loadImages() {
        if (this.isLoading || !this.hasMore) return;
        
        this.isLoading = true;
        this.loading.style.display = 'block';
        
        try {
            const response = await fetch(`/api/images?page=${this.currentPage}&limit=${this.limit}&sort=${this.sortBy}&show=${this.showMode}`);
            
            if (response.status === 401) {
                // 未授权，重定向到登录页面
                window.location.href = '/login.html';
                return;
            }
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            this.totalImages = data.pagination.total;
            this.hasMore = data.pagination.hasNext;
            
            // 保存当前图片列表用于模态框导航
            if (this.currentPage === 1) {
                this.currentImages = data.images;
            } else {
                this.currentImages = [...this.currentImages, ...data.images];
            }
            
            // 渲染图片
            data.images.forEach(img => this.addImageCard(img));
            
            this.loadedImages += data.images.length;
            this.currentPage++;
            
            this.updateStats();
            
            // 如果没有更多图片，显示结束消息
            if (!this.hasMore) {
                this.showEndMessage();
            }
        } catch (error) {
            console.error('加载图片失败:', error);
            if (error.message.includes('401')) {
                window.location.href = '/login.html';
            }
        } finally {
            this.isLoading = false;
            this.loading.style.display = 'none';
        }
    }
}

// 初始化图片库
document.addEventListener('DOMContentLoaded', () => {
    new ImageGallery();
});
