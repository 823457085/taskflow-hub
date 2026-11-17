import React, { useId } from 'react';
import { Card, Empty as AntEmpty, Form } from 'antd';

export const Field: React.FC<{ label: string; children: React.ReactElement; hint?: string }> = ({ label, children, hint }) => {
  const generatedId = useId();
  const child = children as React.ReactElement<{ id?: string }>;
  const id = child.props.id || generatedId;
  return <Form.Item className="workspace-field" label={label} htmlFor={id} extra={hint} layout="vertical" colon={false}>{React.cloneElement(child, { id })}</Form.Item>;
};

export const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => <AntEmpty className="workspace-empty" image={AntEmpty.PRESENTED_IMAGE_SIMPLE} description={children} />;

export const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => <Card className="workspace-section" variant="outlined" title={<h2 className="workspace-section-title">{title}</h2>}>{children}</Card>;
