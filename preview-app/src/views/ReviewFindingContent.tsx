import { Typography } from 'antd';
import { LinkifiedText } from './MarkdownPreview';
import { plainReviewText, reviewDetailSections } from './reviewFindingPresentation';
import './ReviewFindingContent.css';

export { plainReviewText, sortReviewFindings } from './reviewFindingPresentation';

export function ReviewFindingContent({ detail, location, copyLocation = false }: {
  detail: string;
  location?: string | null;
  copyLocation?: boolean;
}) {
  return <dl className="tf-review-finding-content">
    {reviewDetailSections(detail).map((section, index) => <div key={index}>
      <dt>{section.label}</dt>
      <dd><LinkifiedText text={plainReviewText(section.text)} /></dd>
    </div>)}
    {location && <div className="tf-review-finding-reference">
      <dt>参考依据</dt>
      <dd><Typography.Text type="secondary" copyable={copyLocation ? { text: location } : false}><LinkifiedText text={location} /></Typography.Text></dd>
    </div>}
  </dl>;
}
